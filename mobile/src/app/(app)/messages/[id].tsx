import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pickDocument, pickPhoto, type PickOutcome } from '../../../lib/attachments';
import { describeError } from '../../../lib/errors';
import { buildTimeline, typingText } from '../../../lib/chat/messages';
import type { ChatMessage, ConversationDetail } from '../../../lib/chat/types';
import { useMessages } from '../../../queries/chat';
import { chatKeys } from '../../../services/chat-events';
import { getCallManager, sendRealtime } from '../../../services/call-bridge';
import { usePending } from '../../../services/chat-sender';
import { callsSupported } from '../../../services/webrtc-engine';
import { useApp, useEndpoints } from '../../../state/app';
import { useChatLive, useTypingNames } from '../../../state/chat-live';
import { useAppStore, useCan } from '../../../state/store';
import { Button, ErrorView, Loading, Text } from '../../../ui/components';
import { ChatAvatar } from '../../../ui/chat/chat-avatar';
import { MessageBubble, PendingBubble, Quote } from '../../../ui/chat/message-bubble';
import { useDialog } from '../../../ui/dialog';
import { Icon } from '../../../ui/icon';
import { StatusBanners } from '../../../ui/status-banners';
import { radius, space, TOUCH, useColors } from '../../../ui/theme';
import { useToast } from '../../../ui/toast';


export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const { chatSender, services } = useApp();
  const qc = useQueryClient();
  const router = useRouter();
  const c = useColors();
  const dialog = useDialog();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const me = useAppStore((s) => s.user);
  const online = useAppStore((s) => (s.sync ? s.sync.online : true));
  const canCall = useCan('chat.use') && callsSupported();
  const detail = useQuery({ queryKey: chatKeys.conversation(id), queryFn: () => api.chat.conversation(id) });
  const config = useQuery({ queryKey: ['chat', 'config'], queryFn: () => api.chat.config(), staleTime: 3600_000 });
  const msgs = useMessages(id);
  const pending = usePending((s) => s.list).filter((p) => p.conversationId === id);
  const typing = useTypingNames(id);
  const conv = detail.data;
  const meId = me?.id ?? '';

  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  // Keyboard open: the box sits right above the keys (like WhatsApp). iOS lets KeyboardAvoidingView do it; on Android the window does not
  // shrink for the keyboard, so we measure how much of the screen the keyboard covers and lift the whole chat by that amount.
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [lift, setLift] = useState(0);
  const frame = useRef<View>(null);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      setKeyboardUp(true);
      if (Platform.OS !== 'ios') frame.current?.measureInWindow((_x, y, _w, h) => setLift(Math.max(0, Math.round(y + h - e.endCoordinates.screenY))));
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => { setKeyboardUp(false); setLift(0); });
    return () => { show.remove(); hide.remove(); };
  }, []);
  const lastTyping = useRef(0);
  const listRef = useRef<FlatList>(null);

  // the conversation in front of the user: new messages here are read at once, not counted as unread
  useFocusEffect(useCallback(() => { useChatLive.getState().setOpen(id); return () => { if (useChatLive.getState().openConversationId === id) useChatLive.getState().setOpen(null); }; }, [id]));

  // where the user stopped reading (captured once, before we mark everything read)
  const [firstUnreadSeq, setFirstUnreadSeq] = useState<number | null>(null);
  const captured = useRef(false);
  useEffect(() => {
    if (captured.current || !conv || !msgs.messages.length) return;
    captured.current = true;
    const mine = conv.members.find((m) => m.userId === meId);
    const first = msgs.messages.find((m) => m.seq > (mine?.lastReadSeq ?? 0) && m.senderId !== meId && m.kind !== 'SYSTEM');
    setFirstUnreadSeq(first?.seq ?? null);
  }, [conv, msgs.messages, meId]);

  // tell the server what has been read (only while the screen is open and the app is in front)
  const newest = msgs.messages.length ? msgs.messages[msgs.messages.length - 1].seq : 0;
  useEffect(() => {
    if (!newest || AppState.currentState !== 'active') return;
    const mineRead = conv?.members.find((m) => m.userId === meId)?.lastReadSeq ?? 0;
    if (mineRead >= newest && (conv?.unread ?? 0) === 0) return;
    const t = setTimeout(() => {
      void api.chat.markRead(id, newest).then(() => {
        qc.setQueryData(chatKeys.conversation(id), (d: ConversationDetail | undefined) => d && { ...d, unread: 0, members: d.members.map((m) => (m.userId === meId ? { ...m, lastReadSeq: Math.max(m.lastReadSeq, newest), lastDeliveredSeq: Math.max(m.lastDeliveredSeq, newest) } : m)) });
        void qc.invalidateQueries({ queryKey: chatKeys.conversations }); void qc.invalidateQueries({ queryKey: chatKeys.unread });
      }).catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [newest, id, conv?.unread, conv?.members, meId, api, qc]);

  const timeline = useMemo(() => buildTimeline(msgs.messages, pending), [msgs.messages, pending]);
  const data = useMemo(() => [...timeline].reverse(), [timeline]);
  const group = conv?.type === 'GROUP';
  const iAmAdmin = conv?.myRole === 'ADMIN';
  const title = conv?.title ?? '…';

  function onChange(t: string) {
    setText(t);
    if (t.trim() && Date.now() - lastTyping.current > 2000) { lastTyping.current = Date.now(); sendRealtime('chat.typing', { conversationId: id }); }
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    if (editing) {
      try { await api.chat.edit(editing.id, body); setEditing(null); setText(''); } catch (e) { toast.show(describeError(e), 'error'); }
      return;
    }
    const err = chatSender.send({ conversationId: id, kind: 'TEXT', body, replyToId: replyTo?.id });
    if (err) return void toast.show(err, 'error');
    setText(''); setReplyTo(null);
  }

  async function attach() {
    if (!config.data?.attachments) return void dialog.notify({ title: 'File sharing is not available', message: 'Ask your administrator to set up file storage for chat.', tone: 'info' });
    const pick = await dialog.ask<'library' | 'camera' | 'file' | 'cancel'>({
      title: 'Share', message: 'What would you like to send?', tone: 'info', icon: 'attach',
      actions: [{ label: 'Photo from library', value: 'library' }, { label: 'Take a photo', value: 'camera', variant: 'secondary' }, { label: 'Document', value: 'file', variant: 'secondary' }, { label: 'Cancel', value: 'cancel', variant: 'ghost' }],
    });
    if (!pick || pick === 'cancel') return;
    await new Promise((r) => setTimeout(r, Platform.OS === 'ios' ? 700 : 150)); // let the dialog finish closing before a system screen opens (iOS drops the request otherwise)
    const r: PickOutcome = pick === 'file' ? await pickDocument() : await pickPhoto(pick);
    if (!r.ok) {
      if (r.reason === 'permission_denied') void dialog.notify({ title: 'Permission needed', message: pick === 'camera' ? 'Allow camera access in your phone settings to take a photo.' : 'Allow photo access in your phone settings to choose a picture.', tone: 'warn' });
      else if (r.reason === 'invalid' || r.reason === 'error') void dialog.notify({ title: 'Cannot share this file', message: r.message ?? 'Try a different file.', tone: 'danger' });
      return;
    }
    const err = chatSender.send({ conversationId: id, kind: r.file.mimeType.startsWith('image/') ? 'IMAGE' : 'FILE', body: text.trim() || undefined, replyToId: replyTo?.id, file: r.file });
    if (err) return void toast.show(err, 'error');
    setText(''); setReplyTo(null);
  }

  async function options(m: ChatMessage) {
    const mine = m.senderId === meId;
    const canEdit = mine && m.kind === 'TEXT' && !m.deleted && Date.now() - new Date(m.createdAt).getTime() < (config.data?.editWindowMinutes ?? 60) * 60_000;
    const canDelete = !m.deleted && (mine || (group && iAmAdmin));
    const pick = await dialog.ask<'reply' | 'copy' | 'edit' | 'delete' | 'report' | 'cancel'>({
      title: 'Message', tone: 'info', icon: 'chatbubble-ellipses-outline',
      actions: [
        ...(!m.deleted ? [{ label: 'Reply', value: 'reply' as const }] : []),
        ...(!m.deleted && m.body ? [{ label: 'Copy text', value: 'copy' as const, variant: 'secondary' as const }] : []),
        ...(canEdit ? [{ label: 'Edit', value: 'edit' as const, variant: 'secondary' as const }] : []),
        ...(canDelete ? [{ label: 'Delete', value: 'delete' as const, variant: 'danger' as const }] : []),
        ...(!mine && !m.deleted ? [{ label: 'Report', value: 'report' as const, variant: 'ghost' as const }] : []),
        { label: 'Cancel', value: 'cancel' as const, variant: 'ghost' as const },
      ],
    });
    if (pick === 'reply') setReplyTo(m);
    else if (pick === 'copy') { await Clipboard.setStringAsync(m.body); toast.show('Copied'); }
    else if (pick === 'edit') { setEditing(m); setText(m.body); setReplyTo(null); }
    else if (pick === 'delete') {
      if (await dialog.confirm({ title: 'Delete this message?', message: 'It will disappear for everyone in this conversation.', confirmLabel: 'Delete', destructive: true })) {
        try { await api.chat.remove(m.id); } catch (e) { toast.show(describeError(e), 'error'); }
      }
    } else if (pick === 'report') {
      const why = await dialog.ask<string>({ title: 'Report this message', message: 'Why are you reporting it? Administrators can review reports.', tone: 'warn', actions: [{ label: 'Abusive or harassing', value: 'Abusive or harassing' }, { label: 'Spam', value: 'Spam', variant: 'secondary' }, { label: 'Something else', value: 'Other', variant: 'secondary' }, { label: 'Cancel', value: '', variant: 'ghost' }] });
      if (why) { try { await api.chat.report(m.id, why); toast.show('Reported. Thank you.'); } catch (e) { toast.show(describeError(e), 'error'); } }
    }
  }

  function call(kind: 'AUDIO' | 'VIDEO') {
    if (!conv) return;
    void getCallManager(services.api).start(conv.id, conv.peerId, conv.title ?? 'Call', kind);
  }

  function jumpTo(messageId: string) {
    const idx = data.findIndex((i) => i.type === 'message' && i.message.id === messageId);
    if (idx >= 0) listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
  }

  const subtitle = typing.length ? typingText(typing) : group ? `${conv?.memberCount ?? 0} people` : conv?.peerOnline ? 'Online' : '';
  const members = conv?.members ?? [];

  // memoized so the navigator is not handed new header functions on every render (that loops once typing/presence updates arrive)
  const peerId = conv?.type === 'DIRECT' ? conv.peerId : null;
  const headerOptions = useMemo(() => ({
      headerTitle: () => (
        <Pressable accessibilityRole="button" accessibilityLabel={`${title}. Conversation details`} onPress={() => router.push({ pathname: '/messages/info/[id]', params: { id } } as never)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 230 }}>
          <ChatAvatar name={title} size={36} userId={peerId} groupId={group ? id : undefined} hasAvatar={conv?.hasAvatar} version={conv?.avatarVersion} online={conv?.peerOnline} />
          <View style={{ flexShrink: 1 }}>
            <Text variant="bodyStrong" numberOfLines={1}>{title}</Text>
            {subtitle ? <Text variant="caption" color={typing.length ? c.primary : c.muted} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
        </Pressable>
      ),
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          {canCall && !group ? (
            <>
              <Pressable accessibilityRole="button" accessibilityLabel="Voice call" hitSlop={6} onPress={() => call('AUDIO')} style={{ width: 40, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}><Icon name="call-outline" size="md" color={c.text} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Video call" hitSlop={6} onPress={() => call('VIDEO')} style={{ width: 40, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}><Icon name="videocam-outline" size="md" color={c.text} /></Pressable>
            </>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Conversation details" hitSlop={6} onPress={() => router.push({ pathname: '/messages/info/[id]', params: { id } } as never)} style={{ width: 40, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}><Icon name="information-circle-outline" size="md" color={c.text} /></Pressable>
        </View>
      ),
    }), [title, subtitle, typing.length, c, router, id, group, peerId, conv?.hasAvatar, conv?.avatarVersion, conv?.peerOnline, canCall]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View ref={frame} collapsable={false} style={{ flex: 1, backgroundColor: c.bg, paddingBottom: lift }}>
      <Stack.Screen options={headerOptions} />
      <StatusBanners />
      {!online ? <View accessibilityLiveRegion="polite" style={{ backgroundColor: c.warnSoft, padding: space.sm }}><Text variant="caption" color={c.warn} style={{ textAlign: 'center' }}>You are offline. Messages will be sent when you are back online.</Text></View> : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
        {detail.error && !conv ? <ErrorView message={describeError(detail.error)} onRetry={() => void detail.refetch()} /> : msgs.isLoading ? <Loading /> : msgs.error && !msgs.messages.length ? <ErrorView message={describeError(msgs.error)} onRetry={() => void msgs.refetch()} /> : (
          <FlatList
            ref={listRef} inverted data={data} keyExtractor={(i) => i.key} keyboardShouldPersistTaps="handled" onScrollToIndexFailed={() => undefined}
            onEndReached={() => { if (msgs.hasNextPage && !msgs.isFetchingNextPage) void msgs.fetchNextPage(); }} onEndReachedThreshold={0.3}
            ListEmptyComponent={<View style={{ transform: [{ scaleY: -1 }], padding: space.xl, alignItems: 'center' }}><Text muted style={{ textAlign: 'center' }}>No messages yet. Say hello!</Text></View>}
            ListFooterComponent={msgs.isFetchingNextPage ? <Loading label="Loading earlier messages" /> : msgs.hasNextPage ? <View style={{ padding: space.md }}><Button title="Load earlier messages" variant="ghost" small onPress={() => void msgs.fetchNextPage()} /></View> : null}
            contentContainerStyle={{ paddingVertical: space.sm }}
            renderItem={({ item }) => {
              if (item.type === 'day') return <View style={{ alignItems: 'center', paddingVertical: space.sm }}><View style={{ paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: c.card, borderWidth: 1, borderColor: c.border }}><Text variant="caption" muted>{item.label}</Text></View></View>;
              if (item.type === 'pending') return <PendingBubble p={item.pending} onRetry={(k) => chatSender.retry(k)} onDiscard={(k) => chatSender.discard(k)} />;
              const m = item.message;
              return (
                <View>
                  {firstUnreadSeq !== null && m.seq === firstUnreadSeq ? <View style={{ alignItems: 'center', paddingVertical: space.sm }}><Text variant="caption" bold color={c.primary}>New messages</Text></View> : null}
                  <MessageBubble m={m} mine={m.senderId === meId} group={!!group} members={members} meId={meId} onLongPress={(x) => void options(x)} onReplyPress={jumpTo} />
                </View>
              );
            }}
          />
        )}

        {replyTo || editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: c.card, borderTopWidth: 1, borderColor: c.border }}>
            <View style={{ flex: 1 }}>
              {editing ? <><Text variant="caption" bold color={c.primary}>Editing message</Text><Text variant="caption" muted numberOfLines={1}>{editing.body}</Text></>
                : replyTo ? <Quote r={{ id: replyTo.id, senderId: replyTo.senderId, senderName: replyTo.senderId === meId ? 'You' : replyTo.senderName, kind: replyTo.kind, preview: replyTo.body || (replyTo.kind === 'IMAGE' ? 'Photo' : 'File'), deleted: false }} mine={false} /> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} onPress={() => { setReplyTo(null); setEditing(null); setText(''); }}><Icon name="close" size="md" color={c.muted} /></Pressable>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, padding: space.sm, paddingBottom: space.sm + (keyboardUp ? 0 : insets.bottom), backgroundColor: c.bg, borderTopWidth: 1, borderColor: c.border }}>
          {!editing ? <Pressable accessibilityRole="button" accessibilityLabel="Attach a file or photo" onPress={() => void attach()} style={{ width: TOUCH, height: TOUCH, alignItems: 'center', justifyContent: 'center' }}><Icon name="add-circle-outline" size="lg" color={c.primary} /></Pressable> : null}
          <TextInput
            accessibilityLabel="Message" value={text} onChangeText={onChange} placeholder="Message" placeholderTextColor={c.muted} multiline maxLength={4000} cursorColor={c.primary} selectionColor={c.primary}
            style={{ flex: 1, minHeight: TOUCH - 4, maxHeight: 120, color: c.text, backgroundColor: c.input, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, paddingHorizontal: space.md, paddingTop: Platform.OS === 'ios' ? 12 : 8, paddingBottom: Platform.OS === 'ios' ? 12 : 8, fontSize: 16, textAlignVertical: 'center' }}
          />
          <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Save edit' : 'Send message'} accessibilityState={{ disabled: !text.trim() }} disabled={!text.trim()} onPress={() => void send()}
            style={{ width: TOUCH, height: TOUCH, borderRadius: radius.pill, backgroundColor: text.trim() ? c.primary : c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={editing ? 'checkmark' : 'send'} size="md" color={text.trim() ? c.onPrimary : c.muted} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
