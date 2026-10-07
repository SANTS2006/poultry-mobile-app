import type { PushMessage, PushProvider, PushReceipt, PushTicket } from './push.provider';

/** Used when push is not configured (development, test): in-app notifications still work, nothing leaves the server. */
export class NoopPushProvider implements PushProvider {
  readonly name = 'none';
  readonly enabled = false;
  async send(_messages: PushMessage[]): Promise<PushTicket[]> { return []; }
  async receipts(_ids: string[]): Promise<Record<string, PushReceipt>> { return {}; }
}
