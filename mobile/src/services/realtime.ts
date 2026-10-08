/** The subset of a Socket.IO client this module uses (lets tests drive it with a fake). */
export interface SocketLike {
  connected: boolean;
  on(event: string, handler: (...args: any[]) => void): unknown;
  emit(event: string, payload?: unknown, ack?: (res: unknown) => void): unknown;
  disconnect(): unknown;
}
export type SocketFactory = (
  url: string,
  opts: { path: string; transports: string[]; auth: (cb: (data: object) => void) => void; reconnection: boolean; reconnectionDelayMax: number },
) => SocketLike;

const TOPIC_PERMISSION: Record<string, string> = {
  production: 'production.read', inventory: 'inventory.read', sales: 'sales.read', payments: 'payments.read', expenses: 'expenses.read',
  customers: 'customers.read', dashboard: 'dashboard.read',
};

/** Topics this user may subscribe to (the server enforces the same mapping; asking only for what is allowed avoids pointless denials). */
export const topicsFor = (permissions: readonly string[]): string[] =>
  Object.entries(TOPIC_PERMISSION).filter(([, p]) => permissions.includes(p)).map(([t]) => t);

/** Query-key prefixes to refetch when an event arrives. Events carry ids only, so screens always re-read data through the permission-checked REST API. */
export function invalidationsFor(event: string): string[][] {
  switch (event) {
    case 'production.created': case 'production.updated': return [['production'], ['dashboard'], ['inventory']];
    case 'inventory.updated': return [['inventory'], ['dashboard']];
    case 'sale.created': case 'sale.updated': return [['sales'], ['dashboard'], ['inventory'], ['customers']];
    case 'payment.created': return [['payments'], ['sales'], ['customers'], ['dashboard']];
    case 'expense.created': case 'expense.updated': return [['expenses'], ['dashboard']];
    case 'customer.created': case 'customer.updated': return [['customers']];
    case 'dashboard.invalidate': return [['dashboard']];
    case 'notification.created': return [['notifications']];
    default: return [];
  }
}

export const REALTIME_EVENTS = [
  'production.created', 'production.updated', 'inventory.updated', 'sale.created', 'sale.updated', 'payment.created', 'expense.created',
  'expense.updated', 'customer.created', 'customer.updated', 'dashboard.invalidate', 'notification.created',
] as const;

export interface RealtimeDeps {
  url: string;
  factory: SocketFactory;
  /** returns a currently valid access token (refreshing if needed) */
  getToken: () => Promise<string>;
  permissions: () => readonly string[];
  onInvalidate: (keys: string[][]) => void;
  /** the server ended this session for good (revoked / disabled): the app must sign out */
  onSessionEnded: () => void;
  onStatus?: (s: 'connected' | 'disconnected') => void;
  /** a notification was just created for this user (the app shows a small in-app banner) */
  onNotification?: () => void;
}

/**
 * Live updates. Realtime is a HINT to refetch, never a source of truth: if the socket is down the app still works (pull-to-refresh,
 * refetch on focus/reconnect). The socket is authenticated with the access token in the handshake (never in the URL), re-subscribes
 * after every reconnect, and re-authenticates in place when the server warns that the token is about to expire.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;

  constructor(private readonly d: RealtimeDeps) {}

  get connected(): boolean { return this.socket?.connected ?? false; }

  start(): void {
    if (this.socket) return;
    const s = this.d.factory(this.d.url, {
      path: '/realtime', transports: ['websocket'], reconnection: true, reconnectionDelayMax: 30_000,
      // called on every (re)connect attempt so a reconnect after token expiry uses a fresh token
      auth: (cb) => { this.d.getToken().then((token) => cb({ token })).catch(() => cb({ token: '' })); },
    });
    this.socket = s;
    s.on('ready', () => { this.d.onStatus?.('connected'); this.subscribe(); });
    s.on('disconnect', () => this.d.onStatus?.('disconnected'));
    s.on('auth.expiring', () => { void this.reauth(); });
    s.on('auth.revoked', (p: { reason?: string }) => {
      // Token expiry is routine (the socket reconnects with a fresh token); everything else means the session is over.
      if (p?.reason === 'token_expired' || p?.reason === 'rate_limited' || p?.reason === 'reauth_failed') return;
      this.d.onSessionEnded();
    });
    s.on('subscription.revoked', () => undefined); // permissions changed: the topic simply stops arriving
    for (const e of REALTIME_EVENTS) {
      s.on(e, () => {
        this.d.onInvalidate(invalidationsFor(e));
        if (e === 'notification.created') this.d.onNotification?.();
      });
    }
  }

  stop(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.d.onStatus?.('disconnected');
  }

  private subscribe(): void {
    const topics = topicsFor(this.d.permissions());
    if (topics.length) this.socket?.emit('subscribe', { topics });
  }

  private async reauth(): Promise<void> {
    try {
      const accessToken = await this.d.getToken();
      this.socket?.emit('reauth', { accessToken });
    } catch { /* the server closes the socket at expiry and the reconnect logic takes over */ }
  }
}
