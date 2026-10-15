import { useQuery } from '@tanstack/react-query';
import { Image, Linking, Pressable, View } from 'react-native';
import { callMessageText, deliveryStatus, formatFileSize, timeLabel } from '../../lib/chat/messages';
import type { ChatMessage, ConversationMember, PendingMessage } from '../../lib/chat/types';
import { useEndpoints } from '../../state/app';
import { Text } from '../components';
import { Icon } from '../icon';
import { radius, space, useColors } from '../theme';

/** A short-lived download link for an attachment (refreshed before it expires). Fetched only when the bubble is on screen. */
function useAttachmentUrl(id: string | undefined, enabled: boolean) {
  const api = useEndpoints();
  return useQuery({ queryKey: ['chat', 'attachment', id], enabled: enabled && !!id, staleTime: 4 * 60_000, gcTime: 5 * 60_000, queryFn: () => api.chat.downloadUrl(id as string) });
}

function Ticks({ status, color }: { status: ReturnType<typeof deliveryStatus> | 'sending' | 'failed'; color: string }) {
  const c = useColors();
  if (status === 'sending') return <Icon name="time-outline" size={13} color={color} />;
  if (status === 'failed') return <Icon name="alert-circle" size={14} color={c.danger} />;
  if (status === 'sent') return <Icon name="checkmark" size={14} color={color} />;
  return <Icon name="checkmark-done" size={14} color={status === 'read' ? c.info : color} />;
}

export function Quote({ r, mine }: { r: NonNullable<ChatMessage['replyTo']>; mine: boolean }) {
  const c = useColors();
  return (
    <View style={{ borderLeftWidth: 3, borderLeftColor: mine ? c.onPrimary : c.primary, paddingLeft: space.sm, marginBottom: space.xs, opacity: 0.9 }}>
      <Text variant="caption" bold color={mine ? c.onPrimary : c.primary} numberOfLines={1}>{r.senderName ?? 'Message'}</Text>
      <Text variant="caption" color={mine ? c.onPrimary : c.textSecondary} numberOfLines={2}>{r.deleted ? 'Message deleted' : r.preview}</Text>
    </View>
  );
}

function AttachmentView({ a, mine, kind }: { a: NonNullable<ChatMessage['attachment']>; mine: boolean; kind: string }) {
  const c = useColors();
  const isImage = kind === 'IMAGE';
  const q = useAttachmentUrl(a.id, true);
  const fg = mine ? c.onPrimary : c.text;
  if (isImage) {
    return q.data ? (
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Photo ${a.fileName}. Tap to open`} onPress={() => void Linking.openURL(q.data.url)}>
        <Image accessibilityIgnoresInvertColors source={{ uri: q.data.url }} style={{ width: 220, height: 220, borderRadius: radius.md, backgroundColor: c.skeleton }} resizeMode="cover" />
      </Pressable>
    ) : <View style={{ width: 220, height: 160, borderRadius: radius.md, backgroundColor: c.skeleton, alignItems: 'center', justifyContent: 'center' }}><Text variant="caption" muted>{q.isError ? 'Photo unavailable' : 'Loading photo…'}</Text></View>;
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`File ${a.fileName}, ${formatFileSize(a.sizeBytes)}. Tap to open`} disabled={!q.data} onPress={() => q.data && void Linking.openURL(q.data.url)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minWidth: 200 }}>
      <Icon name="document-text-outline" size="lg" color={fg} />
      <View style={{ flex: 1 }}><Text color={fg} numberOfLines={2} bold>{a.fileName}</Text><Text variant="caption" color={fg}>{formatFileSize(a.sizeBytes)}{q.isError ? ' · unavailable' : ''}</Text></View>
    </Pressable>
  );
}

/** One chat bubble: mine on the right (with delivery ticks), others on the left (with the sender's name in groups). */
export function MessageBubble({ m, mine, group, members, meId, onLongPress, onReplyPress }: {
  m: ChatMessage; mine: boolean; group: boolean; members: readonly ConversationMember[]; meId: string; onLongPress: (m: ChatMessage) => void; onReplyPress?: (id: string) => void;
}) {
  const c = useColors();
  if (m.kind === 'SYSTEM') return <View style={{ alignItems: 'center', paddingVertical: space.sm, paddingHorizontal: space.xl }}><Text variant="caption" muted style={{ textAlign: 'center' }}>{m.body}</Text></View>;
  if (m.kind === 'CALL') {
    const missed = /MISSED|REJECTED|BUSY|FAILED|CANCELLED/.test(m.body);
    return (
      <View style={{ alignItems: 'center', paddingVertical: space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: c.card, borderWidth: 1, borderColor: c.border }}>
          <Icon name={m.body.startsWith('VIDEO') ? 'videocam-outline' : 'call-outline'} size={16} color={missed ? c.danger : c.textSecondary} />
          <Text variant="caption" color={missed ? c.danger : c.textSecondary}>{callMessageText(m.body)} · {timeLabel(m.createdAt)}</Text>
        </View>
      </View>
    );
  }
  const bg = mine ? c.primary : c.card; const fg = mine ? c.onPrimary : c.text;
  const status = mine ? deliveryStatus(m.seq, meId, members) : null;
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 2, alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${mine ? 'You' : m.senderName ?? 'Someone'}: ${m.deleted ? 'message deleted' : m.attachment ? `${m.kind === 'IMAGE' ? 'photo' : 'file'} ${m.body}` : m.body}. ${timeLabel(m.createdAt)}${status ? `. ${status}` : ''}`}
        accessibilityHint="Long press for options" onLongPress={() => onLongPress(m)} delayLongPress={350}
        style={{ maxWidth: '82%', backgroundColor: m.deleted ? 'transparent' : bg, borderWidth: m.deleted || !mine ? 1 : 0, borderColor: c.border, borderRadius: radius.lg, borderBottomRightRadius: mine ? 6 : radius.lg, borderBottomLeftRadius: mine ? radius.lg : 6, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 }}>
        {group && !mine && m.senderName ? <Text variant="caption" bold color={c.primary} numberOfLines={1}>{m.senderName}</Text> : null}
        {m.replyTo ? <Pressable onPress={() => onReplyPress?.(m.replyTo!.id)}><Quote r={m.replyTo} mine={mine} /></Pressable> : null}
        {m.deleted ? <Text color={c.muted} style={{ fontStyle: 'italic' }}>This message was deleted</Text> : (
          <>
            {m.attachment ? <AttachmentView a={m.attachment} mine={mine} kind={m.kind} /> : null}
            {m.body ? <Text color={fg} selectable>{m.body}</Text> : null}
          </>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' }}>
          {m.editedAt && !m.deleted ? <Text variant="caption" color={mine ? c.onPrimary : c.muted} style={{ fontSize: 10 }}>edited</Text> : null}
          <Text variant="caption" color={mine ? c.onPrimary : c.muted} style={{ fontSize: 10, opacity: 0.85 }}>{timeLabel(m.createdAt)}</Text>
          {status ? <Ticks status={status} color={c.onPrimary} /> : null}
        </View>
      </Pressable>
    </View>
  );
}

/** A message that has not reached the server yet: clock while sending, red with Retry / Discard when it failed. */
export function PendingBubble({ p, onRetry, onDiscard }: { p: PendingMessage; onRetry: (id: string) => void; onDiscard: (id: string) => void }) {
  const c = useColors();
  const failed = p.status === 'failed';
  return (
    <View style={{ paddingHorizontal: space.md, paddingVertical: 2, alignItems: 'flex-end' }}>
      <View style={{ maxWidth: '82%', backgroundColor: c.primary, opacity: failed ? 0.75 : 0.9, borderRadius: radius.lg, borderBottomRightRadius: 6, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 4, borderWidth: failed ? 2 : 0, borderColor: c.danger }}>
        {p.file ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}><Icon name={p.kind === 'IMAGE' ? 'image-outline' : 'document-text-outline'} size="md" color={c.onPrimary} /><Text color={c.onPrimary} numberOfLines={1} style={{ flex: 1 }}>{p.file.fileName}</Text></View> : null}
        {p.body ? <Text color={c.onPrimary}>{p.body}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' }}>
          <Text variant="caption" color={c.onPrimary} style={{ fontSize: 10 }}>{timeLabel(p.createdAt)}</Text>
          <Ticks status={failed ? 'failed' : 'sending'} color={c.onPrimary} />
        </View>
      </View>
      {failed ? (
        <View style={{ alignItems: 'flex-end', gap: 2, paddingTop: 2, maxWidth: '82%' }}>
          <Text variant="caption" color={c.danger} style={{ textAlign: 'right' }}>{p.error ?? 'Not sent'}</Text>
          <View style={{ flexDirection: 'row', gap: space.lg }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry sending" hitSlop={8} onPress={() => onRetry(p.clientId)}><Text variant="caption" bold color={c.primary}>Retry</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Discard message" hitSlop={8} onPress={() => onDiscard(p.clientId)}><Text variant="caption" bold color={c.danger}>Discard</Text></Pressable>
          </View>
        </View>
      ) : p.error ? <Text variant="caption" muted style={{ textAlign: 'right', maxWidth: '82%' }}>{p.error}</Text> : null}
    </View>
  );
}
