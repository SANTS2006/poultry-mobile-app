import type { ChatMessage } from '../lib/chat/types';
import { ChatSender, usePending, type SenderDeps } from './chat-sender';

const server = (clientId: string, id = 'm1'): ChatMessage => ({ id, conversationId: 'c', seq: 1, senderId: 'me', senderName: 'Me', kind: 'TEXT', body: 'hi', clientId, replyTo: null, attachment: null, createdAt: 'x', editedAt: null, deleted: false });
const httpErr = (status: number, message?: string) => Object.assign(new Error('http'), { status, body: message ? { message } : null });

function setup(send: SenderDeps['api']['send']) {
  const kv = new Map<string, string>(); const sent: ChatMessage[] = []; let n = 0;
  const api = { send: jest.fn(send), createUpload: jest.fn(async () => ({ attachmentId: 'att1', uploadUrl: 'https://r2/put', headers: { 'Content-Type': 'image/png' } })), completeUpload: jest.fn(async () => ({})) };
  const upload = jest.fn(async () => undefined);
  const s = new ChatSender({ api, upload, kv: { getKv: async (k) => kv.get(k) ?? null, setKv: async (k, v) => { kv.set(k, v); } }, newId: () => `id${++n}`, onSent: (m) => sent.push(m), now: () => new Date('2026-10-10T10:00:00Z') });
  return { s, api, upload, kv, sent };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('ChatSender', () => {
  beforeEach(() => { jest.useFakeTimers(); usePending.getState().set([]); });
  afterEach(() => jest.useRealTimers());

  it('shows the message at once as sending, then removes it when the server confirms (using one clientId)', async () => {
    const { s, api, sent } = setup(async (_c, b) => server(b.clientId));
    expect(s.send({ conversationId: 'c', kind: 'TEXT', body: '  hello  ' })).toBeNull();
    expect(usePending.getState().list).toMatchObject([{ clientId: 'id1', body: 'hello', status: 'sending' }]);
    await flush();
    expect(usePending.getState().list).toEqual([]); expect(sent).toHaveLength(1);
    expect(api.send).toHaveBeenCalledWith('c', expect.objectContaining({ clientId: 'id1', kind: 'TEXT', body: 'hello' }));
  });
  it('refuses empty text and bad files without queueing anything', () => {
    const { s } = setup(async () => server('x'));
    expect(s.send({ conversationId: 'c', kind: 'TEXT', body: '   ' })).toMatch(/Write a message/);
    expect(s.send({ conversationId: 'c', kind: 'FILE', file: { uri: 'u', fileName: 'a.exe', mimeType: 'application/x-msdownload', sizeBytes: 10 } })).toMatch(/cannot be shared/);
    expect(usePending.getState().list).toEqual([]);
  });
  it('retries network failures with back-off using the SAME clientId, then succeeds', async () => {
    let calls = 0;
    const { s, api, sent } = setup(async (_c, b) => { if (++calls < 3) throw Object.assign(new Error('offline'), { status: null }); return server(b.clientId); });
    s.send({ conversationId: 'c', kind: 'TEXT', body: 'hi' }); await flush();
    expect(usePending.getState().list[0]).toMatchObject({ status: 'sending' }); expect(usePending.getState().list[0].error).toMatch(/No connection/);
    jest.advanceTimersByTime(1000); await flush(); jest.advanceTimersByTime(2000); await flush();
    expect(sent).toHaveLength(1); expect(usePending.getState().list).toEqual([]);
    expect(new Set(api.send.mock.calls.map((c) => c[1].clientId))).toEqual(new Set(['id1']));
  });
  it('marks a refused message failed straight away (with the server\'s reason) and lets the user retry or discard it', async () => {
    let refuse = true;
    const { s, api } = setup(async (_c, b) => { if (refuse) throw httpErr(403, 'You cannot message this person.'); return server(b.clientId); });
    s.send({ conversationId: 'c', kind: 'TEXT', body: 'hi' }); await flush();
    expect(usePending.getState().list[0]).toMatchObject({ status: 'failed', error: 'You cannot message this person.' }); expect(api.send).toHaveBeenCalledTimes(1);
    refuse = false; s.retry('id1'); await flush();
    expect(usePending.getState().list).toEqual([]);
    refuse = true; s.send({ conversationId: 'c', kind: 'TEXT', body: 'again' }); await flush(); s.discard('id2'); expect(usePending.getState().list).toEqual([]);
  });
  it('gives up after 5 automatic attempts but keeps the text for a manual retry', async () => {
    const { s, api } = setup(async () => { throw httpErr(503); });
    s.send({ conversationId: 'c', kind: 'TEXT', body: 'hi' }); await flush();
    for (let i = 0; i < 6; i++) { jest.advanceTimersByTime(31_000); await flush(); }
    expect(api.send).toHaveBeenCalledTimes(5); expect(usePending.getState().list[0]).toMatchObject({ status: 'failed', body: 'hi' });
  });
  it('uploads a file once, even if sending the message needs a retry', async () => {
    let first = true;
    const { s, api, upload } = setup(async (_c, b) => { if (first) { first = false; throw httpErr(500); } return { ...server(b.clientId), kind: 'IMAGE' as const }; });
    s.send({ conversationId: 'c', kind: 'IMAGE', file: { uri: 'file://p.png', fileName: 'p.png', mimeType: 'image/png', sizeBytes: 2000 } }); await flush();
    jest.advanceTimersByTime(1100); await flush();
    expect(upload).toHaveBeenCalledTimes(1); expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenLastCalledWith('c', expect.objectContaining({ attachmentId: 'att1', kind: 'IMAGE' }));
  });
  it('keeps unsent messages across an app restart (as failed, ready to retry)', async () => {
    const a = setup(async () => { throw httpErr(400, 'nope'); });
    a.s.send({ conversationId: 'c', kind: 'TEXT', body: 'important' }); await flush();
    usePending.getState().set([]);
    const b = setup(async (_c, x) => server(x.clientId)); b.kv.set('chat.outbox.v1', a.kv.get('chat.outbox.v1') as string);
    await b.s.restore();
    expect(usePending.getState().list).toMatchObject([{ body: 'important', status: 'failed' }]);
    b.s.retryAll(); await flush(); expect(usePending.getState().list).toEqual([]);
  });
});
