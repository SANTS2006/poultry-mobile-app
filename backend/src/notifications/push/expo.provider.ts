import { PushMessage, PushProvider, PushReceipt, PushTicket, PushTransportError } from './push.provider';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_CHUNK = 100; // Expo accepts at most 100 messages per request
const RECEIPT_CHUNK = 1000;

/**
 * Expo Push Service client (works with the standard EAS/Expo setup; APNs and FCM credentials are configured in EAS, not here).
 * The optional access token (PUSH_NOTIFICATION_CONFIG) is sent as a bearer token when Expo's "enhanced push security" is enabled.
 * Tokens and message contents are never logged.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  readonly enabled = true;

  constructor(private readonly accessToken: string, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i as never) as never, private readonly timeoutMs = 15_000) {}

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += SEND_CHUNK) {
      const chunk = messages.slice(i, i + SEND_CHUNK);
      const body = (await this.post(SEND_URL, chunk.map((m) => ({
        to: m.to, title: m.title, body: m.body, data: m.data, channelId: m.channelId, priority: m.priority, sound: 'default',
      })))) as { data?: { status: string; id?: string; message?: string; details?: { error?: string } }[] };
      const data = body.data;
      if (!Array.isArray(data) || data.length !== chunk.length) throw new PushTransportError('unexpected response from the push service');
      for (const t of data) {
        tickets.push(t.status === 'ok' && t.id ? { status: 'ok', id: t.id } : { status: 'error', error: t.details?.error ?? 'Unknown', message: safe(t.message) });
      }
    }
    return tickets;
  }

  async receipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (let i = 0; i < ticketIds.length; i += RECEIPT_CHUNK) {
      const body = (await this.post(RECEIPTS_URL, { ids: ticketIds.slice(i, i + RECEIPT_CHUNK) })) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> };
      for (const [id, r] of Object.entries(body.data ?? {})) {
        out[id] = r.status === 'ok' ? { status: 'ok' } : { status: 'error', error: r.details?.error ?? 'Unknown', message: safe(r.message) };
      }
    }
    return out;
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST', signal: ctl.signal, body: JSON.stringify(payload),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}) },
      });
      if (!res.ok) throw new PushTransportError(`push service answered HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e instanceof PushTransportError) throw e;
      throw new PushTransportError('could not reach the push service');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Provider error text may echo a token; keep it short and strip anything token-shaped before it is stored. */
const safe = (m?: string): string | undefined => m?.replace(/Expo(nent)?PushToken\[[^\]]*\]/g, '[token]').slice(0, 200);
