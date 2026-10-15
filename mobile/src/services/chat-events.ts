import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Endpoints } from '../api/endpoints';
import type { Page } from '../api/types';
import { applyReceipt, upsertMessage } from '../lib/chat/messages';
import type { ChatMessage, ConversationDetail, ConversationSummary } from '../lib/chat/types';
import { useChatLive } from '../state/chat-live';

type MsgPage = { items: ChatMessage[]; hasMore: boolean; nextBefore: number | null };
type MsgData = InfiniteData<MsgPage, number | undefined>;
type ConvData = InfiniteData<Page<ConversationSummary>, number>;

export const chatKeys = {
  conversations: ['chat', 'conversations'] as const,
  conversation: (id: string) => ['chat', 'conversation', id] as const,
  messages: (id: string) => ['chat', 'messages', id] as const,
  unread: ['chat', 'unread'] as const,
};

/** Puts a message into the newest cached page (de-duplicated, in order). Does nothing if that conversation was never opened (it loads fresh later). */
export function insertMessage(data: MsgData | undefined, m: ChatMessage): MsgData | undefined {
  if (!data || !data.pages.length) return data;
  const [first, ...rest] = data.pages;
  const exists = data.pages.some((p) => p.items.some((x) => x.id === m.id));
  if (exists) return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.some((x) => x.id === m.id) ? upsertMessage(p.items, m) : p.items })) };
  return { ...data, pages: [{ ...first, items: upsertMessage(first.items, m) }, ...rest] };
}

/** Updates one conversation row wherever it is in the cached list pages. */
export function patchConversation(data: ConvData | undefined, id: string, fn: (c: ConversationSummary) => ConversationSummary): ConvData | undefined {
  if (!data) return data;
  return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === id ? fn(c) : c)) })) };
}

/** Moves the touched conversation to the top (the list is sorted by latest message). */
export function bumpToTop(data: ConvData | undefined, id: string): ConvData | undefined {
  if (!data) return data;
  const all = data.pages.flatMap((p) => p.items);
  const hit = all.find((c) => c.id === id);
  if (!hit) return data;
  const first = data.pages[0];
  return { ...data, pages: [{ ...first, items: [hit, ...first.items.filter((c) => c.id !== id)] }, ...data.pages.slice(1).map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) }))] };
}

export const removeConversation = (data: ConvData | undefined, id: string): ConvData | undefined =>
  data && { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((c) => c.id !== id) })) };

export interface ChatEventContext {
  qc: QueryClient; api: Endpoints; meId: string;
  send(event: string, payload: unknown): void;
  appActive(): boolean;
  onCallEvent?(name: 'call.incoming' | 'call.updated' | 'call.signal', payload: any): void;  
}

/** Per-conversation debounce: one cumulative delivery ack / read mark per burst of messages. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** ids of messages whose arrival was already counted (unread badges, delivery acks) */
const seenMessages = new Set<string>();
export const resetSeenMessages = (): void => seenMessages.clear();
function debounced(key: string, ms: number, fn: () => void) { const t = timers.get(key); if (t) clearTimeout(t); timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms)); }

/**
 * Applies one realtime chat event to the local cache. The server only ever sends these to people who may see them; this just keeps the screens
 * current without refetching. Anything unknown (a brand-new conversation) triggers a refetch instead of guessing.
 */
export function handleChatEvent(ctx: ChatEventContext, name: string, p: any): void {  
  const { qc } = ctx; const live = useChatLive.getState();
  if (name === 'chat.message' || name === 'chat.conversation' || (name === 'chat.receipt' && p?.userId === ctx.meId)) void qc.invalidateQueries({ queryKey: chatKeys.unread });
  switch (name) {
    case 'chat.message': {
      const m = p as ChatMessage;
      if (seenMessages.has(m.id)) { qc.setQueryData<MsgData>(chatKeys.messages(m.conversationId), (d) => insertMessage(d, m)); return; } // a duplicate delivery: refresh the copy, count nothing twice
      seenMessages.add(m.id); if (seenMessages.size > 500) seenMessages.delete(seenMessages.values().next().value as string);
      qc.setQueryData<MsgData>(chatKeys.messages(m.conversationId), (d) => insertMessage(d, m));
      const mine = m.senderId === ctx.meId;
      const open = live.openConversationId === m.conversationId && ctx.appActive();
      const known = qc.getQueryData<ConvData>(chatKeys.conversations)?.pages.some((pg) => pg.items.some((c) => c.id === m.conversationId));
      if (!known) void qc.invalidateQueries({ queryKey: chatKeys.conversations });
      else {
        qc.setQueryData<ConvData>(chatKeys.conversations, (d) => bumpToTop(patchConversation(d, m.conversationId, (c) => ({
          ...c, lastSeq: Math.max(c.lastSeq, m.seq), lastMessageAt: m.createdAt,
          lastMessage: { id: m.id, kind: m.kind, preview: m.deleted ? 'Message deleted' : m.kind === 'IMAGE' ? 'Photo' : m.kind === 'FILE' ? 'File' : m.body.slice(0, 80), senderId: m.senderId, senderName: m.senderName, createdAt: m.createdAt, deleted: m.deleted },
          unread: mine || open || m.kind === 'SYSTEM' ? c.unread : c.unread + 1,
        })), m.conversationId));
      }
      live.clearTyping(m.conversationId, m.senderId ?? undefined);
      if (!mine) {
        // "delivered" is reported only now, because the message really reached this phone
        debounced(`d:${m.conversationId}`, 300, () => ctx.send('chat.delivered', { conversationId: m.conversationId, upToSeq: m.seq }));
        if (open) debounced(`r:${m.conversationId}`, 600, () => { void ctx.api.chat.markRead(m.conversationId, m.seq).catch(() => undefined); });
      }
      return;
    }
    case 'chat.message.updated': {
      const m = p as ChatMessage;
      qc.setQueryData<MsgData>(chatKeys.messages(m.conversationId), (d) => insertMessage(d, m));
      return;
    }
    case 'chat.receipt': {
      qc.setQueryData<ConversationDetail>(chatKeys.conversation(p.conversationId), (d) => d && { ...d, members: applyReceipt(d.members, p) });
      if (p.userId === ctx.meId && typeof p.read === 'number') qc.setQueryData<ConvData>(chatKeys.conversations, (d) => patchConversation(d, p.conversationId, (c) => (p.read >= c.lastSeq ? { ...c, unread: 0 } : c)));
      return;
    }
    case 'chat.typing': live.setTyping(p.conversationId, p.userId, p.name); return;
    case 'chat.conversation':
      if (p.change === 'removed') { qc.setQueryData<ConvData>(chatKeys.conversations, (d) => removeConversation(d, p.id)); qc.removeQueries({ queryKey: chatKeys.messages(p.id) }); qc.removeQueries({ queryKey: chatKeys.conversation(p.id) }); return; }
      void qc.invalidateQueries({ queryKey: chatKeys.conversations });
      void qc.invalidateQueries({ queryKey: chatKeys.conversation(p.id) });
      return;
    case 'presence':
      live.setOnline(p.userId, !!p.online);
      return;
    case 'call.incoming': case 'call.updated': case 'call.signal':
      ctx.onCallEvent?.(name, p);
      if (name === 'call.updated') void qc.invalidateQueries({ queryKey: ['chat', 'calls'] });
      return;
    default: return;
  }
}

/** Total unread across conversations (for the badge on the Messages button). */
export const totalUnread = (data: ConvData | undefined): number => (data ? data.pages.flatMap((p) => p.items).reduce((n, c) => n + (c.muted ? 0 : c.unread), 0) : 0);
