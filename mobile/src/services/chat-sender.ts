import { create } from 'zustand';
import type { ChatMessage, PendingMessage } from '../lib/chat/types';
import { backoffMs, isRetryable, parsePending, serializePending } from '../lib/chat/outbox';
import { checkAttachment } from '../lib/chat/messages';

export const usePending = create<{ list: PendingMessage[]; set(l: PendingMessage[]): void }>((set) => ({ list: [], set: (list) => set({ list }) }));

export interface SenderDeps {
  api: {
    send(conversationId: string, b: { clientId: string; kind: 'TEXT' | 'IMAGE' | 'FILE'; body?: string; replyToId?: string; attachmentId?: string }): Promise<ChatMessage>;
    createUpload(b: { conversationId: string; fileName: string; mimeType: string; sizeBytes: number }): Promise<{ attachmentId: string; uploadUrl: string; headers: Record<string, string> }>;
    completeUpload(id: string): Promise<unknown>;
  };
  /** PUTs the local file to the pre-signed URL */
  upload(uri: string, url: string, headers: Record<string, string>): Promise<void>;
  kv: { getKv(k: string): Promise<string | null>; setKv(k: string, v: string): Promise<void> };
  newId(): string;
  onSent(m: ChatMessage): void;
  now?: () => Date;
}

const KEY = 'chat.outbox.v1';
const MAX_AUTO_ATTEMPTS = 5;
const status = (e: unknown): number | null => (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number' ? (e as { status: number }).status : null);
const messageOf = (e: unknown): string => {
  const body = e && typeof e === 'object' && 'body' in e ? (e as { body?: { message?: string | string[] } }).body : null;
  const m = Array.isArray(body?.message) ? body?.message.join(' ') : body?.message;
  return m || (status(e) === null ? 'No connection. It will be sent when you are back online.' : 'The message could not be sent.');
};

/**
 * Sends messages reliably: the text appears at once as "sending", is saved on the phone, retried with back-off while the network is down, and
 * only shown as "failed" (with a Retry button) when the server refuses it or the retries are used up. The same clientId is used for every
 * attempt, so a retry after a timeout can never create a second message (the server returns the original).
 */
export class ChatSender {
  private attempts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Set<string>();

  constructor(private readonly d: SenderDeps) {}

  private get list(): PendingMessage[] { return usePending.getState().list; }
  private write(next: PendingMessage[]): void { usePending.getState().set(next); void this.d.kv.setKv(KEY, serializePending(next)).catch(() => undefined); }
  private patch(clientId: string, p: Partial<PendingMessage>): void { this.write(this.list.map((x) => (x.clientId === clientId ? { ...x, ...p } : x))); }

  /** Loads unsent messages saved before the app was closed (shown as failed with Retry). */
  async restore(): Promise<void> { this.write(parsePending(await this.d.kv.getKv(KEY))); }
  clear(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this.attempts.clear(); usePending.getState().set([]); void this.d.kv.setKv(KEY, '').catch(() => undefined); }

  /** Returns an error text when the message is refused before sending (nothing is queued in that case). */
  send(o: { conversationId: string; kind: 'TEXT' | 'IMAGE' | 'FILE'; body?: string; replyToId?: string; file?: PendingMessage['file'] }): string | null {
    const body = (o.body ?? '').trim();
    if (o.kind === 'TEXT' && !body) return 'Write a message first.';
    if (o.file) { const bad = checkAttachment(o.file.mimeType, o.file.sizeBytes); if (bad) return bad; }
    const p: PendingMessage = { clientId: this.d.newId(), conversationId: o.conversationId, kind: o.kind, body, replyToId: o.replyToId, file: o.file, createdAt: (this.d.now?.() ?? new Date()).toISOString(), status: 'sending' };
    this.write([...this.list, p]);
    void this.attempt(p.clientId);
    return null;
  }

  retry(clientId: string): void {
    if (!this.list.some((p) => p.clientId === clientId) || this.inflight.has(clientId)) return;
    this.attempts.set(clientId, 0);
    this.patch(clientId, { status: 'sending', error: undefined });
    void this.attempt(clientId);
  }

  /** Retries everything waiting (called when the network or the socket comes back). */
  retryAll(): void { for (const p of this.list) if (p.status === 'failed' && !this.inflight.has(p.clientId)) this.retry(p.clientId); }

  discard(clientId: string): void { const t = this.timers.get(clientId); if (t) clearTimeout(t); this.timers.delete(clientId); this.write(this.list.filter((p) => p.clientId !== clientId)); }

  private async attempt(clientId: string): Promise<void> {
    const p = this.list.find((x) => x.clientId === clientId);
    if (!p || this.inflight.has(clientId)) return;
    this.inflight.add(clientId);
    try {
      let attachmentId = p.file?.attachmentId;
      if (p.file && !attachmentId) {
        const up = await this.d.api.createUpload({ conversationId: p.conversationId, fileName: p.file.fileName, mimeType: p.file.mimeType, sizeBytes: p.file.sizeBytes });
        await this.d.upload(p.file.uri, up.uploadUrl, up.headers);
        await this.d.api.completeUpload(up.attachmentId);
        attachmentId = up.attachmentId;
        this.patch(clientId, { file: { ...p.file, attachmentId } }); // a retry after this point does not upload again
      }
      const m = await this.d.api.send(p.conversationId, { clientId, kind: p.kind, body: p.body || undefined, replyToId: p.replyToId, attachmentId });
      this.write(this.list.filter((x) => x.clientId !== clientId));
      this.attempts.delete(clientId);
      this.d.onSent(m);
    } catch (e) {
      const n = (this.attempts.get(clientId) ?? 0) + 1;
      this.attempts.set(clientId, n);
      if (isRetryable(status(e)) && n < MAX_AUTO_ATTEMPTS) {
        this.timers.set(clientId, setTimeout(() => { this.timers.delete(clientId); void this.attempt(clientId); }, backoffMs(n - 1)));
        this.patch(clientId, { error: messageOf(e) }); // still "sending": the bubble shows the clock and the reason
      } else this.patch(clientId, { status: 'failed', error: messageOf(e) });
    } finally { this.inflight.delete(clientId); }
  }
}
