import type { MediaStorage } from '../src/chat/media.storage';
import type { PushMessage, PushProvider, PushReceipt, PushTicket } from '../src/notifications/push/push.provider';

/** In-memory object store standing in for Cloudflare R2: tests "upload" by putting an object under the key the API chose. */
export class FakeMedia implements MediaStorage {
  readonly configured = true;
  readonly objects = new Map<string, { sizeBytes: number; mimeType: string }>();
  readonly deleted: string[] = [];
  async presignPut(key: string) { return `https://r2.invalid/put/${key}?sig=test`; }
  async presignGet(key: string, fileName: string) { return `https://r2.invalid/get/${key}?name=${encodeURIComponent(fileName)}&sig=test`; }
  async head(key: string) { return this.objects.get(key) ?? null; }
  async delete(key: string) { this.deleted.push(key); this.objects.delete(key); }
}

export class CapturePush implements PushProvider {
  readonly name = 'capture'; readonly enabled = true;
  sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushTicket[]> { this.sent.push(...messages); return messages.map((_, i) => ({ status: 'ok', id: `t${this.sent.length}-${i}` })); }
  async receipts(): Promise<Record<string, PushReceipt>> { return {}; }
  reset() { this.sent = []; }
}
