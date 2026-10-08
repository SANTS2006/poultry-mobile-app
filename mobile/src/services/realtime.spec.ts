import { invalidationsFor, RealtimeClient, topicsFor, type SocketLike } from './realtime';

class FakeSocket implements SocketLike {
  connected = true;
  handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  sent: { event: string; payload: unknown }[] = [];
  disconnected = false;
  on(e: string, h: (...a: unknown[]) => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), h]); return this; }
  emit(event: string, payload?: unknown) { this.sent.push({ event, payload }); return this; }
  disconnect() { this.disconnected = true; this.connected = false; return this; }
  fire(e: string, ...a: unknown[]) { (this.handlers.get(e) ?? []).forEach((h) => h(...a)); }
}

function setup(permissions: string[] = ['sales.read', 'inventory.read', 'dashboard.read'], onNotification?: () => void) {
  const socket = new FakeSocket();
  let authFn: ((cb: (d: object) => void) => void) | undefined;
  const invalidated: string[][][] = [];
  let ended = 0;
  const status: string[] = [];
  let token = 'tok-1';
  const rt = new RealtimeClient({
    url: 'https://api',
    factory: (_u, o) => { authFn = o.auth; expect(o.transports).toEqual(['websocket']); expect(o.path).toBe('/realtime'); return socket; },
    getToken: async () => token, permissions: () => permissions, onInvalidate: (k) => invalidated.push(k), onSessionEnded: () => { ended++; }, onStatus: (s) => status.push(s), onNotification,
  });
  return { rt, socket, invalidated, ended: () => ended, status, auth: () => new Promise<object>((r) => authFn!(r)), setToken: (t: string) => { token = t; } };
}

describe('realtime client', () => {
  it('sends the token in the handshake auth (fresh on every attempt), never in the URL', async () => {
    const s = setup();
    s.rt.start();
    expect(await s.auth()).toEqual({ token: 'tok-1' });
    s.setToken('tok-2');
    expect(await s.auth()).toEqual({ token: 'tok-2' });
  });

  it('subscribes only to topics the user may read, again after every (re)connect', () => {
    const s = setup(['sales.read', 'dashboard.read']);
    s.rt.start();
    s.socket.fire('ready');
    s.socket.fire('ready'); // after a reconnect
    expect(s.socket.sent.filter((m) => m.event === 'subscribe')).toEqual([
      { event: 'subscribe', payload: { topics: ['sales', 'dashboard'] } },
      { event: 'subscribe', payload: { topics: ['sales', 'dashboard'] } },
    ]);
    expect(topicsFor([])).toEqual([]);
  });

  it('subscribes to nothing when the user has no readable topics', () => {
    const s = setup([]);
    s.rt.start();
    s.socket.fire('ready');
    expect(s.socket.sent).toHaveLength(0);
  });

  it('turns business events into refetch hints', () => {
    const s = setup();
    s.rt.start();
    s.socket.fire('sale.created', { entityId: 'x' });
    s.socket.fire('dashboard.invalidate');
    expect(s.invalidated[0]).toEqual(expect.arrayContaining([['sales'], ['dashboard'], ['inventory']]));
    expect(s.invalidated[1]).toEqual([['dashboard']]);
    expect(invalidationsFor('something.else')).toEqual([]);
  });

  it('re-authenticates in place with a fresh token when the server warns of expiry', async () => {
    const s = setup();
    s.rt.start();
    s.setToken('tok-fresh');
    s.socket.fire('auth.expiring');
    await new Promise((r) => setTimeout(r, 5));
    expect(s.socket.sent).toContainEqual({ event: 'reauth', payload: { accessToken: 'tok-fresh' } });
  });

  it('signs the app out only for a definitive revocation, not for routine expiry', () => {
    const s = setup();
    s.rt.start();
    for (const reason of ['token_expired', 'rate_limited', 'reauth_failed']) s.socket.fire('auth.revoked', { reason });
    expect(s.ended()).toBe(0);
    for (const reason of ['session_revoked', 'account_disabled', 'session_invalid']) s.socket.fire('auth.revoked', { reason });
    expect(s.ended()).toBe(3);
  });

  it('reports connection state and stops cleanly', () => {
    const s = setup();
    s.rt.start();
    s.rt.start(); // idempotent
    s.socket.fire('ready');
    expect(s.status).toEqual(['connected']);
    s.rt.stop();
    expect(s.socket.disconnected).toBe(true);
    expect(s.status.at(-1)).toBe('disconnected');
    expect(s.rt.connected).toBe(false);
  });
});

describe('realtime client: notifications', () => {
  it('refreshes the notification list and the bell count, and tells the app a new notification arrived', () => {
    const seen: string[] = [];
    const s = setup(['sales.read'], () => seen.push('notice'));
    s.rt.start();
    s.socket.fire('notification.created', { name: 'notification.created' });
    expect(s.invalidated.at(-1)).toEqual([['notifications']]); // the unread query lives under ['notifications']
    expect(seen).toEqual(['notice']);
    s.socket.fire('sale.created');
    expect(seen).toEqual(['notice']); // other events do not raise the banner
  });
});
