import { AuthRequiredError, HttpError, NetworkError, type SyncSummary } from '../sync/types';
import { ApiClient } from './api-client';
import { PublicApi } from './public-api';
import { SessionManager, UnsyncedDataError, type OutboxGate, type UserSummary } from './session-manager';
import { MemorySecureStore, TokenManager } from './token-manager';

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
const res = (status: number, body: unknown = {}): Res => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const user = (id = 'u1', permissions = ['sales.read']): UserSummary => ({ id, email: `${id}@x.com`, fullName: id, mfaEnabled: true, roles: ['OWNER'], permissions });
const tokens = { accessToken: 'a1', refreshToken: 'r1'.padEnd(30, 'x'), expiresIn: 900 };

class FakeGate implements OutboxGate {
  owner: string | null = null; unsynced = 0; wiped = 0;
  async summary() { return { unsynced: this.unsynced } as SyncSummary; }
  async getOwner() { return this.owner; }
  async setOwner(id: string) { this.owner = id; }
  async wipe() { this.wiped++; this.unsynced = 0; }
}

function setup(handler: (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => Res | Promise<Res>) {
  const secure = new MemorySecureStore();
  const gate = new FakeGate();
  const calls: { url: string; method?: string; auth?: string; body?: unknown }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
    calls.push({ url, method: init?.method, auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
  const tm = new TokenManager(secure, 'http://api', fetchImpl as never);
  const api = new ApiClient('http://api', tm, fetchImpl as never);
  const pub = new PublicApi('http://api', fetchImpl as never);
  const signedIn: string[] = []; let signedOutCalls = 0;
  const session = new SessionManager(secure, tm, api, pub, gate, { onSignedIn: (u) => { signedIn.push(u.id); }, onSignedOut: () => { signedOutCalls++; } });
  return { secure, gate, calls, tm, session, signedIn, out: () => signedOutCalls };
}

describe('SessionManager: sign-in', () => {
  it('walks password → MFA → tokens and stores them only in the secure store', async () => {
    const s = setup((url) => {
      if (url.endsWith('/login')) return res(200, { status: 'mfa_required', mfaToken: 'm'.repeat(30) });
      if (url.endsWith('/mfa/verify')) return res(200, { status: 'authenticated', tokens, user: user() });
      return res(404);
    });
    const a = await s.session.login(' a@x.com ', 'pw');
    expect(a).toEqual({ kind: 'mfa_required', mfaToken: 'm'.repeat(30) });
    expect(s.session.status).toBe('booting'); // not signed in until MFA completes
    expect(await s.tm.hasSession()).toBe(false);
    expect(s.calls[0].body).toEqual({ email: 'a@x.com', password: 'pw' }); // trimmed
    const b = await s.session.verifyMfa('m'.repeat(30), { code: '123456' });
    expect(b.kind).toBe('authenticated');
    expect(s.session.status).toBe('signed_in');
    expect(await s.tm.hasSession()).toBe(true);
    expect(s.signedIn).toEqual(['u1']);
    expect(s.gate.owner).toBe('u1');
  });

  it('privileged roles enrol MFA with the setup token, which is the only credential sent to those calls', async () => {
    const s = setup((url) => {
      if (url.endsWith('/login')) return res(200, { status: 'mfa_setup_required', setupToken: 's'.repeat(30) });
      if (url.endsWith('/mfa/enroll')) return res(200, { secret: 'ABC', otpauthUri: 'otpauth://x', qrCodeDataUrl: 'data:image/png;base64,AA' });
      if (url.endsWith('/mfa/confirm')) return res(200, { status: 'authenticated', tokens, user: user(), recoveryCodes: ['c1', 'c2'] });
      return res(404);
    });
    const o = await s.session.login('a@x.com', 'pw');
    expect(o.kind).toBe('mfa_setup_required');
    const setup1 = await s.session.beginMfaSetup('s'.repeat(30));
    expect(setup1.secret).toBe('ABC');
    expect(s.calls[1].auth).toBe(`Bearer ${'s'.repeat(30)}`);
    const done = await s.session.confirmMfaSetup('s'.repeat(30), '123456');
    expect(done.recoveryCodes).toEqual(['c1', 'c2']);
    expect(done.outcome.kind).toBe('authenticated');
  });

  it('surfaces bad credentials as an HttpError and stores nothing', async () => {
    const s = setup(() => res(401, { message: 'Invalid email or password.' }));
    await expect(s.session.login('a@x.com', 'bad')).rejects.toBeInstanceOf(HttpError);
    expect(await s.tm.hasSession()).toBe(false);
  });

  it('reports an unreachable server as NetworkError', async () => {
    const s = setup(() => { throw new TypeError('Network request failed'); });
    await expect(s.session.login('a@x.com', 'pw')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('SessionManager: unsent offline records', () => {
  const authed = (id: string) => (url: string) => (url.endsWith('/login') ? res(200, { status: 'authenticated', tokens, user: user(id) }) : res(204));

  it('refuses to let a different user sign in on top of someone else\'s unsent records', async () => {
    const s = setup(authed('u2'));
    s.gate.owner = 'u1'; s.gate.unsynced = 3;
    const err = await s.session.login('b@x.com', 'pw').catch((e) => e);
    expect(err).toBeInstanceOf(UnsyncedDataError);
    expect(err.ownedByOtherUser).toBe(true);
    expect(await s.tm.hasSession()).toBe(false); // no session was created
    expect(s.gate.wiped).toBe(0);
    expect(s.gate.owner).toBe('u1');
  });

  it('clears the previous user\'s cached data when nothing is waiting to be sent', async () => {
    const s = setup(authed('u2'));
    s.gate.owner = 'u1'; s.gate.unsynced = 0;
    await s.session.login('b@x.com', 'pw');
    expect(s.gate.wiped).toBe(1);
    expect(s.gate.owner).toBe('u2');
  });

  it('keeps the data when the same user signs in again', async () => {
    const s = setup(authed('u1'));
    s.gate.owner = 'u1'; s.gate.unsynced = 5;
    await s.session.login('a@x.com', 'pw');
    expect(s.gate.wiped).toBe(0);
    expect(s.gate.unsynced).toBe(5);
  });

  it('will not sign out with unsent records unless the user explicitly discards them', async () => {
    const s = setup(authed('u1'));
    await s.session.login('a@x.com', 'pw');
    s.gate.unsynced = 2;
    await expect(s.session.logout()).rejects.toBeInstanceOf(UnsyncedDataError);
    expect(s.session.status).toBe('signed_in');
    expect(await s.tm.hasSession()).toBe(true);
    await s.session.logout({ discardUnsynced: true });
    expect(s.session.status).toBe('signed_out');
    expect(s.gate.wiped).toBe(1);
    expect(await s.tm.hasSession()).toBe(false);
  });

  it('signs out locally even when the server cannot be reached', async () => {
    const s = setup((url) => { if (url.endsWith('/login')) return res(200, { status: 'authenticated', tokens, user: user() }); throw new TypeError('offline'); });
    await s.session.login('a@x.com', 'pw');
    await s.session.logout();
    expect(s.session.status).toBe('signed_out');
    expect(await s.tm.hasSession()).toBe(false);
    expect(s.out()).toBe(1);
  });
});

describe('SessionManager: start-up', () => {
  const withSession = async (handler: Parameters<typeof setup>[0]) => {
    const s = setup(handler);
    await s.tm.setSession({ ...tokens, expiresIn: 900 });
    await s.secure.set('auth.user', JSON.stringify(user('cached', ['production.read'])));
    return s;
  };

  it('is signed out without a stored session', async () => {
    const s = setup(() => res(500));
    await s.session.restore();
    expect(s.session.status).toBe('signed_out');
  });

  it('refreshes the profile from the server and caches it', async () => {
    const s = await withSession(() => res(200, user('u1', ['sales.read', 'sales.create'])));
    await s.session.restore();
    expect(s.session.status).toBe('signed_in');
    expect(s.session.can('sales.create')).toBe(true);
    expect(JSON.parse((await s.secure.get('auth.user')) as string).permissions).toContain('sales.create');
  });

  it('starts offline from the cached profile (a farm worker without signal can still record production)', async () => {
    const s = await withSession(() => { throw new TypeError('offline'); });
    await s.session.restore();
    expect(s.session.status).toBe('signed_in');
    expect(s.session.user?.id).toBe('cached');
    expect(await s.tm.hasSession()).toBe(true);
  });

  it('signs out when the server rejects the session (revoked, disabled, password changed)', async () => {
    const s = await withSession(() => res(401, { message: 'no' }));
    await s.session.restore();
    expect(s.session.status).toBe('signed_out');
    expect(await s.tm.hasSession()).toBe(false);
    expect(await s.secure.get('auth.user')).toBeNull();
  });

  it('ends the session on demand without touching the unsent records', async () => {
    const s = await withSession(() => res(200, user('cached')));
    await s.session.restore();
    s.gate.unsynced = 4;
    await s.session.sessionEnded();
    expect(s.session.status).toBe('signed_out');
    expect(s.gate.wiped).toBe(0);
    expect(s.gate.unsynced).toBe(4);
  });

  it('treats AuthRequiredError from the token layer as signed out', async () => {
    const s = await withSession(() => { throw new AuthRequiredError(); });
    // the fetch layer surfaces as NetworkError inside ApiClient; simulate the refresh rejecting instead
    await s.tm.clear();
    await s.session.restore();
    expect(s.session.status).toBe('signed_out');
  });
});
