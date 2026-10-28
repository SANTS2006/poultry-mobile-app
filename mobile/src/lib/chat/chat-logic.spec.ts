import { callReducer, idleCall } from './call-machine';
import { applyReceipt, buildTimeline, callMessageText, checkAttachment, dayLabel, deliveryStatus, formatDuration, listTime, typingText, upsertMessage } from './messages';
import { backoffMs, isRetryable, parsePending, serializePending } from './outbox';
import type { ChatMessage, ConversationMember, PendingMessage } from './types';

const msg = (seq: number, o: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${seq}`, conversationId: 'c', seq, senderId: 'a', senderName: 'A', kind: 'TEXT', body: `t${seq}`, clientId: null, replyTo: null, attachment: null, createdAt: `2026-10-10T10:0${seq}:00Z`, editedAt: null, deleted: false, ...o });
const mem = (id: string, d: number, r: number): ConversationMember => ({ userId: id, name: id, role: 'MEMBER', joinedAt: '', online: false, hasAvatar: false, avatarVersion: 0, lastDeliveredSeq: d, lastReadSeq: r });

describe('message list', () => {
  it('keeps order and removes duplicates when the same message arrives twice (push + socket + refetch)', () => {
    let l: ChatMessage[] = [msg(1), msg(3)];
    l = upsertMessage(l, msg(2)); l = upsertMessage(l, msg(2)); l = upsertMessage(l, msg(3, { body: 'edited' }));
    expect(l.map((m) => m.seq)).toEqual([1, 2, 3]); expect(l[2].body).toBe('edited');
  });
  it('replaces the sender\'s own optimistic echo by clientId', () => {
    const l = upsertMessage([msg(1, { id: 'x', clientId: 'cid', senderId: 'me' })], msg(1, { id: 'real', clientId: 'cid', senderId: 'me' }));
    expect(l).toHaveLength(1); expect(l[0].id).toBe('real');
  });
  it('shows unsent messages after the server ones, hides ones the server already confirmed, and adds day separators', () => {
    const pending: PendingMessage[] = [{ clientId: 'k1', conversationId: 'c', kind: 'TEXT', body: 'x', createdAt: '2026-10-10T11:00:00Z', status: 'failed' }, { clientId: 'k2', conversationId: 'c', kind: 'TEXT', body: 'y', createdAt: '2026-10-10T11:01:00Z', status: 'sending' }];
    const t = buildTimeline([msg(1, { clientId: 'k2' }), msg(2)], pending, new Date('2026-10-10T12:00:00Z'));
    expect(t.map((i) => i.type)).toEqual(['day', 'message', 'message', 'pending']);
    expect(t[0]).toMatchObject({ label: 'Today' });
  });
  it('shows delivered/read only when EVERY other member has reported it', () => {
    const members = [mem('me', 9, 9), mem('a', 5, 3), mem('b', 7, 7)];
    expect(deliveryStatus(5, 'me', members)).toBe('delivered');
    expect(deliveryStatus(6, 'me', members)).toBe('sent');
    expect(deliveryStatus(3, 'me', members)).toBe('read');
    expect(deliveryStatus(1, 'me', [mem('me', 0, 0)])).toBe('sent');
  });
  it('receipts only move forward', () => {
    const m = applyReceipt([mem('a', 5, 3)], { userId: 'a', delivered: 2, read: 8 });
    expect(m[0]).toMatchObject({ lastDeliveredSeq: 5, lastReadSeq: 8 });
  });
  it('words times, typing and calls for people', () => {
    const now = new Date(2026, 9, 10, 12, 0);
    expect(dayLabel(new Date(2026, 9, 9, 8).toISOString(), now)).toBe('Yesterday');
    expect(listTime(new Date(2026, 9, 10, 9, 5).toISOString(), now)).toBe('09:05');
    expect(listTime(null, now)).toBe('');
    expect(typingText(['Ama'])).toBe('Ama is typing…'); expect(typingText(['A', 'B'])).toBe('A and B are typing…'); expect(typingText(['A', 'B', 'C'])).toBe('Several people are typing…'); expect(typingText([])).toBe('');
    expect(callMessageText('AUDIO|COMPLETED|93')).toBe('Voice call · 1:33'); expect(callMessageText('VIDEO|MISSED|0')).toBe('Missed video call');
    expect(formatDuration(3725)).toBe('1:02:05'); expect(formatDuration(-4)).toBe('0:00');
  });
  it('checks attachments before upload', () => {
    expect(checkAttachment('image/png', 1000)).toBeNull();
    expect(checkAttachment('application/x-msdownload', 1000)).toMatch(/cannot be shared/);
    expect(checkAttachment('image/png', 51 * 1024 * 1024)).toMatch(/50 MB/);
    expect(checkAttachment('image/png', 0)).toMatch(/empty/);
  });
});

describe('outbox', () => {
  it('survives a restart: everything comes back as "failed" so the user can retry, and junk is ignored', () => {
    const p: PendingMessage = { clientId: 'k', conversationId: 'c', kind: 'TEXT', body: 'hi', createdAt: 'x', status: 'sending' };
    expect(parsePending(serializePending([p]))).toEqual([{ ...p, status: 'failed' }]);
    expect(parsePending('not json')).toEqual([]); expect(parsePending('{"a":1}')).toEqual([]); expect(parsePending(null)).toEqual([]);
    expect(parsePending(JSON.stringify([{ nope: true }, p]))).toHaveLength(1);
  });
  it('backs off exponentially up to 30 s and only retries recoverable failures', () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 30000]);
    expect([null, 408, 429, 500, 503].every(isRetryable)).toBe(true);
    expect([400, 403, 404, 409].some(isRetryable)).toBe(false);
  });
});

describe('call state machine', () => {
  it('walks outgoing → connected → ended and refuses a second call while one is live', () => {
    let s = callReducer(idleCall, { type: 'start', conversationId: 'c', peerId: 'p', peerName: 'A', kind: 'VIDEO' });
    expect(s).toMatchObject({ phase: 'starting', cameraOn: true, speaker: true });
    s = callReducer(s, { type: 'created', callId: 'x' }); expect(s.phase).toBe('ringing_out');
    expect(callReducer(s, { type: 'start', conversationId: 'z', peerId: null, peerName: 'B', kind: 'AUDIO' })).toBe(s);
    expect(callReducer(s, { type: 'incoming', callId: 'y', conversationId: 'z', peerId: 'q', peerName: 'B', kind: 'AUDIO' })).toBe(s);
    s = callReducer(s, { type: 'accepted' }); s = callReducer(s, { type: 'media_connected', at: 5 });
    expect(s).toMatchObject({ phase: 'connected', startedAt: 5 });
    s = callReducer(s, { type: 'media_interrupted' }); expect(s.phase).toBe('reconnecting');
    s = callReducer(s, { type: 'media_restored' }); expect(s.phase).toBe('connected');
    s = callReducer(s, { type: 'ended', reason: 'completed' }); expect(s).toMatchObject({ phase: 'ended', endReason: 'completed' });
    expect(callReducer(s, { type: 'toggle_mute' })).toBe(s); // controls do nothing after the end
    expect(callReducer(s, { type: 'reset' })).toEqual(idleCall);
  });
  it('video-only controls are ignored on a voice call', () => {
    let s = callReducer(idleCall, { type: 'start', conversationId: 'c', peerId: 'p', peerName: 'A', kind: 'AUDIO' });
    s = callReducer(s, { type: 'toggle_camera' }); expect(s.cameraOn).toBe(false);
    s = callReducer(s, { type: 'flip_camera' }); expect(s.frontCamera).toBe(true);
    s = callReducer(s, { type: 'toggle_mute' }); expect(s.muted).toBe(true);
  });
});
