import { QueryClient } from '@tanstack/react-query';
import type { ChatMessage, ConversationDetail, ConversationSummary } from '../lib/chat/types';
import { useChatLive } from '../state/chat-live';
import { bumpToTop, chatKeys, handleChatEvent, insertMessage, resetSeenMessages, totalUnread, type ChatEventContext } from './chat-events';

const conv = (id: string, o: Partial<ConversationSummary> = {}): ConversationSummary => ({ id, type: 'DIRECT', title: id, description: null, hasAvatar: false, avatarVersion: 0, peerId: 'p', peerOnline: false, memberCount: 2, myRole: 'MEMBER', muted: false, unread: 0, lastMessageAt: null, lastSeq: 0, createdAt: 'x', lastMessage: null, ...o });
const msg = (convId: string, seq: number, o: Partial<ChatMessage> = {}): ChatMessage => ({ id: `${convId}-${seq}`, conversationId: convId, seq, senderId: 'other', senderName: 'Other', kind: 'TEXT', body: `m${seq}`, clientId: null, replyTo: null, attachment: null, createdAt: '2026-10-10T10:00:00Z', editedAt: null, deleted: false, ...o });

function ctx(qc: QueryClient, over: Partial<ChatEventContext> = {}) {
  const sent: [string, unknown][] = [];
  const api = { chat: { markRead: jest.fn(async () => ({})) } };
  return { c: { qc, api: api as never, meId: 'me', send: (e: string, p: unknown) => sent.push([e, p]), appActive: () => true, ...over } as ChatEventContext, sent, api };
}

describe('chat cache updates from realtime events', () => {
  beforeEach(() => { jest.useFakeTimers(); useChatLive.getState().reset(); resetSeenMessages(); });
  afterEach(() => jest.useRealTimers());

  it('adds a new message once (duplicates ignored), bumps the conversation to the top, counts it unread and reports delivery after a short pause', () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.conversations, { pages: [{ items: [conv('a'), conv('b')], page: 1, limit: 25, total: 2 }], pageParams: [1] });
    qc.setQueryData(chatKeys.messages('b'), { pages: [{ items: [msg('b', 1)], hasMore: false, nextBefore: null }], pageParams: [undefined] });
    const { c, sent } = ctx(qc);
    handleChatEvent(c, 'chat.message', msg('b', 2)); handleChatEvent(c, 'chat.message', msg('b', 2)); // push + refetch race
    const list = qc.getQueryData<any>(chatKeys.conversations).pages[0].items;  
    expect(list.map((x: ConversationSummary) => x.id)).toEqual(['b', 'a']);
    expect(list[0]).toMatchObject({ unread: 1, lastSeq: 2 }); // the duplicate delivery is not counted twice
    expect(qc.getQueryData<any>(chatKeys.messages('b')).pages[0].items.map((m: ChatMessage) => m.seq)).toEqual([1, 2]);  
    expect(sent).toHaveLength(0); jest.advanceTimersByTime(400);
    expect(sent).toEqual([['chat.delivered', { conversationId: 'b', upToSeq: 2 }]]); // one cumulative ack
  });

  it('does not count my own messages, or messages in the conversation I am looking at (those are marked read instead)', () => {
    const qc = new QueryClient();
    qc.setQueryData(chatKeys.conversations, { pages: [{ items: [conv('a')], page: 1, limit: 25, total: 1 }], pageParams: [1] });
    const { c, api } = ctx(qc);
    handleChatEvent(c, 'chat.message', msg('a', 1, { senderId: 'me' }));
    useChatLive.getState().setOpen('a');
    handleChatEvent(c, 'chat.message', msg('a', 2)); jest.advanceTimersByTime(700);
    expect(qc.getQueryData<any>(chatKeys.conversations).pages[0].items[0].unread).toBe(0);  
    expect(api.chat.markRead).toHaveBeenCalledWith('a', 2);
  });

  it('refetches the list for a conversation it has never seen, and drops a conversation I was removed from', () => {
    const qc = new QueryClient(); const spy = jest.spyOn(qc, 'invalidateQueries');
    qc.setQueryData(chatKeys.conversations, { pages: [{ items: [conv('a')], page: 1, limit: 25, total: 1 }], pageParams: [1] });
    const { c } = ctx(qc);
    handleChatEvent(c, 'chat.message', msg('new', 1)); expect(spy).toHaveBeenCalledWith({ queryKey: chatKeys.conversations });
    handleChatEvent(c, 'chat.conversation', { id: 'a', change: 'removed' });
    expect(qc.getQueryData<any>(chatKeys.conversations).pages[0].items).toEqual([]);  
  });

  it('applies receipts to members (forward only), typing and presence', () => {
    const qc = new QueryClient();
    const detail = { ...conv('a'), members: [{ userId: 'u2', name: 'U2', role: 'MEMBER', joinedAt: '', online: false, hasAvatar: false, avatarVersion: 0, lastReadSeq: 4, lastDeliveredSeq: 4 }] } as ConversationDetail;
    qc.setQueryData(chatKeys.conversation('a'), detail);
    const { c } = ctx(qc);
    handleChatEvent(c, 'chat.receipt', { conversationId: 'a', userId: 'u2', delivered: 9, read: 2 });
    expect(qc.getQueryData<ConversationDetail>(chatKeys.conversation('a'))?.members[0]).toMatchObject({ lastDeliveredSeq: 9, lastReadSeq: 4 });
    handleChatEvent(c, 'chat.typing', { conversationId: 'a', userId: 'u2', name: 'U2' });
    expect(useChatLive.getState().typing.a.u2.name).toBe('U2');
    handleChatEvent(c, 'presence', { userId: 'u2', online: true }); expect(useChatLive.getState().online.u2).toBe(true);
  });

  it('forwards call events to the call manager', () => {
    const calls: string[] = []; const qc = new QueryClient();
    const { c } = ctx(qc, { onCallEvent: (n) => calls.push(n) });
    for (const n of ['call.incoming', 'call.updated', 'call.signal']) handleChatEvent(c, n, {});
    expect(calls).toEqual(['call.incoming', 'call.updated', 'call.signal']);
  });

  it('helpers: totals ignore muted chats; insert/bump are pure', () => {
    const data = { pages: [{ items: [conv('a', { unread: 3 }), conv('b', { unread: 2, muted: true })], page: 1, limit: 25, total: 2 }], pageParams: [1] };
    expect(totalUnread(data)).toBe(3); expect(totalUnread(undefined)).toBe(0);
    expect(bumpToTop(data, 'b')?.pages[0].items[0].id).toBe('b'); expect(data.pages[0].items[0].id).toBe('a');
    expect(insertMessage(undefined, msg('a', 1))).toBeUndefined();
  });
});
