import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { pickAvatar } from '../../../../lib/avatar';
import { describeError } from '../../../../lib/errors';
import type { ConversationDetail, ConversationMember } from '../../../../lib/chat/types';
import { chatKeys } from '../../../../services/chat-events';
import { getCallManager } from '../../../../services/call-bridge';
import { callsSupported } from '../../../../services/webrtc-engine';
import { useApp, useEndpoints } from '../../../../state/app';
import { useAppStore, useCan } from '../../../../state/store';
import { Badge, Button, Card, ErrorView, Field, ListRow, Loading, SectionHeader, Text , Avatar } from '../../../../ui/components';
import { ChatAvatar } from '../../../../ui/chat/chat-avatar';
import { UserPicker } from '../../../../ui/chat/user-picker';
import { useDialog } from '../../../../ui/dialog';
import { SheetScreen } from '../../../../ui/sheet-screen';
import { space, useColors } from '../../../../ui/theme';
import { useToast } from '../../../../ui/toast';

/** Details of a conversation: mute, call, people, and (for group admins) rename / add / remove / roles. */
export default function ConversationInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useEndpoints();
  const { services } = useApp();
  const qc = useQueryClient();
  const router = useRouter();
  const dialog = useDialog();
  const toast = useToast();
  const c = useColors();
  const meId = useAppStore((s) => s.user?.id) ?? '';
  const canCall = useCan('chat.use') && callsSupported();
  const q = useQuery({ queryKey: chatKeys.conversation(id), queryFn: () => api.chat.conversation(id) });
  const blocks = useQuery({ queryKey: ['chat', 'blocks'], queryFn: () => api.chat.blocks() });
  const [adding, setAdding] = useState<Set<string> | null>(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: chatKeys.conversation(id) }); void qc.invalidateQueries({ queryKey: chatKeys.conversations }); };
  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) toast.show(ok); refresh(); } catch (e) { toast.show(describeError(e), 'error'); } finally { setBusy(false); } };

  if (q.isLoading) return <SheetScreen title="Details"><Loading /></SheetScreen>;
  if (q.error || !q.data) return <SheetScreen title="Details"><ErrorView message={describeError(q.error)} onRetry={() => void q.refetch()} /></SheetScreen>;
  const conv: ConversationDetail = q.data;
  const group = conv.type === 'GROUP';
  const admin = conv.myRole === 'ADMIN';
  const blocked = blocks.data?.some((b) => b.userId === conv.peerId) ?? false;

  async function memberActions(m: ConversationMember) {
    if (m.userId === meId) return;
    const pick = await dialog.ask<'admin' | 'member' | 'remove' | 'chat' | 'cancel'>({
      title: m.name, message: m.role === 'ADMIN' ? 'Group admin' : 'Member', tone: 'info', icon: 'person-circle-outline',
      actions: [
        { label: 'Send a message', value: 'chat' },
        ...(admin ? [m.role === 'ADMIN' ? { label: 'Remove as admin', value: 'member' as const, variant: 'secondary' as const } : { label: 'Make group admin', value: 'admin' as const, variant: 'secondary' as const }, { label: 'Remove from group', value: 'remove' as const, variant: 'danger' as const }] : []),
        { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      ],
    });
    if (pick === 'chat') { try { const d = await api.chat.openDirect(m.userId); router.replace({ pathname: '/messages/[id]', params: { id: d.id } } as never); } catch (e) { toast.show(describeError(e), 'error'); } }
    else if (pick === 'admin') await run(() => api.chat.setRole(id, m.userId, 'ADMIN'), `${m.name} is now an admin`);
    else if (pick === 'member') await run(() => api.chat.setRole(id, m.userId, 'MEMBER'));
    else if (pick === 'remove' && await dialog.confirm({ title: `Remove ${m.name}?`, message: 'They will no longer see this group.', confirmLabel: 'Remove', destructive: true })) await run(() => api.chat.removeMember(id, m.userId));
  }

  async function leave() {
    if (!(await dialog.confirm({ title: 'Leave this group?', message: 'You will stop receiving its messages.', confirmLabel: 'Leave', destructive: true }))) return;
    setBusy(true);
    try { await api.chat.removeMember(id, meId); await qc.invalidateQueries({ queryKey: chatKeys.conversations }); router.dismissAll(); router.replace('/messages' as never); }
    catch (e) { toast.show(describeError(e), 'error'); setBusy(false); }
  }

  async function changePhoto() {
    const r = await pickAvatar('library');
    if (r.ok) await run(() => api.chat.updateGroup(id, { avatar: r.dataUrl }), 'Group picture updated');
  }

  if (adding) {
    return (
      <SheetScreen title="Add people" scroll={false}>
        <UserPicker selected={adding} exclude={conv.members.map((m) => m.userId)} onPick={(u) => setAdding((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}
          header={<View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, flexDirection: 'row', gap: space.sm }}>
            <View style={{ flex: 1 }}><Button title={`Add ${adding.size || ''}`.trim()} disabled={adding.size === 0} busy={busy} onPress={() => void run(async () => { await api.chat.addMembers(id, [...adding]); setAdding(null); })} /></View>
            <Button title="Cancel" variant="ghost" onPress={() => setAdding(null)} />
          </View>} />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen title={group ? 'Group details' : 'Contact'}>
      <Card style={{ alignItems: 'center', gap: space.sm }}>
        <ChatAvatar name={conv.title ?? '?'} size={88} userId={group ? null : conv.peerId} groupId={group ? id : undefined} hasAvatar={conv.hasAvatar} version={conv.avatarVersion} online={conv.peerOnline} />
        {editName !== null ? (
          <View style={{ alignSelf: 'stretch', gap: space.sm }}>
            <Field label="Group name" value={editName} onChangeText={setEditName} maxLength={80} />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <View style={{ flex: 1 }}><Button title="Save" busy={busy} disabled={!editName.trim()} onPress={() => void run(async () => { await api.chat.updateGroup(id, { title: editName.trim() }); setEditName(null); }, 'Group renamed')} /></View>
              <Button title="Cancel" variant="ghost" onPress={() => setEditName(null)} />
            </View>
          </View>
        ) : <Text variant="title" style={{ textAlign: 'center' }}>{conv.title}</Text>}
        {group && conv.description ? <Text muted style={{ textAlign: 'center' }}>{conv.description}</Text> : null}
        {!group ? <Text variant="caption" muted>{conv.peerOnline ? 'Online' : 'Offline'}</Text> : <Text variant="caption" muted>{conv.memberCount} people</Text>}
        {group && admin && editName === null ? (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Rename" variant="secondary" small icon="create-outline" onPress={() => setEditName(conv.title ?? '')} />
            <Button title="Picture" variant="secondary" small icon="image-outline" onPress={() => void changePhoto()} />
          </View>
        ) : null}
      </Card>

      {canCall && !group ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}><Button title="Voice call" icon="call-outline" variant="secondary" onPress={() => { router.back(); void getCallManager(services.api).start(id, conv.peerId, conv.title ?? 'Call', 'AUDIO'); }} /></View>
          <View style={{ flex: 1 }}><Button title="Video call" icon="videocam-outline" variant="secondary" onPress={() => { router.back(); void getCallManager(services.api).start(id, conv.peerId, conv.title ?? 'Call', 'VIDEO'); }} /></View>
        </View>
      ) : null}

      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1 }}><Text variant="bodyStrong">Mute notifications</Text><Text variant="caption" muted>Messages still arrive; no alerts or badges.</Text></View>
        <Switch accessibilityLabel="Mute notifications" value={conv.muted} onValueChange={(v) => void run(() => api.chat.mute(id, v))} trackColor={{ true: c.primary }} />
      </Card>

      {group ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title={`People (${conv.memberCount})`} action={admin ? { label: 'Add', onPress: () => setAdding(new Set()) } : undefined} />
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {conv.members.map((m) => (
              <ListRow key={m.userId} title={m.userId === meId ? `${m.name} (you)` : m.name} subtitle={m.online ? 'Online' : undefined} badge={m.role === 'ADMIN' ? <Badge tone="info" label="Admin" /> : undefined}
                right={<Avatar name={m.name} size={36} />} onPress={m.userId === meId ? undefined : () => void memberActions(m)} />
            ))}
          </Card>
          <Button title="Leave group" variant="danger" icon="exit-outline" busy={busy} onPress={() => void leave()} />
        </View>
      ) : (
        <Button title={blocked ? 'Unblock this person' : 'Block this person'} variant={blocked ? 'secondary' : 'danger'} icon="ban-outline" busy={busy}
          onPress={() => void (async () => {
            if (!blocked && !(await dialog.confirm({ title: `Block ${conv.title}?`, message: 'You will not receive their messages or calls, and they cannot start new ones.', confirmLabel: 'Block', destructive: true }))) return;
            await run(async () => { if (blocked) await api.chat.unblock(conv.peerId as string); else await api.chat.block(conv.peerId as string); await qc.invalidateQueries({ queryKey: ['chat', 'blocks'] }); }, blocked ? 'Unblocked' : 'Blocked');
          })()} />
      )}
    </SheetScreen>
  );
}
