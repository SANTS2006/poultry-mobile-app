import { ApiClient } from './api-client';
import { MemorySecureStore, TokenManager } from './token-manager';
import { AuthRequiredError, HttpError, NetworkError } from '../sync/types';
import { ReferenceCache } from '../sync/reference-cache';
import { MemoryOutboxStorage } from '../sync/storage';
import { FakeTransport } from '../sync/test-helpers';

type Res = { ok: boolean; status: number; json(): Promise<unknown> };
const res = (status: number, body: unknown = {}): Res => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup(handler: (url: string, init?: { headers?: Record<string, string>; body?: string }) => Promise<Res> | Res, clockMs = { v: 1_000_000 }) {
  const store = new MemorySecureStore();
  const calls: { url: string; auth?: string }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return handler(url, init);
  };
  const tokens = new TokenManager(store, 'http://api', fetchImpl as never, {}, () => clockMs.v);
  const api = new ApiClient('http://api', tokens, fetchImpl as never);
  return { store, tokens, api, calls, clock: clockMs };
}

describe('TokenManager: single-flight refresh', () => {
  it('makes exactly ONE refresh call when many requests notice an expired token at the same time', async () => {
    let n = 0;
    const s = setup(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) { await new Promise((r) => setTimeout(r, 30)); return res(200, { accessToken: `access-${++n}`, refreshToken: `refresh-${n}`, expiresIn: 900 }); }
      return res(200, { ok: true });
    });
    await s.tokens.setSession({ accessToken: 'old', refreshToken: 'refresh-0', expiresIn: 1 });
    s.clock.v += 5_000; // expired
    const tokens = await Promise.all(Array.from({ length: 8 }, () => s.tokens.getAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(['access-1']));
    expect(s.tokens.refreshCalls).toBe(1);
    expect(await s.store.get('auth.refresh')).toBe('refresh-1'); // rotated token stored
  });

  it('uses a still-valid token without calling the server', async () => {
    const s = setup(() => res(500));
    await s.tokens.setSession({ accessToken: 'fresh', refreshToken: 'r', expiresIn: 900 });
    expect(await s.tokens.getAccessToken()).toBe('fresh');
    expect(s.calls).toHaveLength(0);
  });

  it('keeps the session when the network or server is down during refresh; only a definitive rejection ends it', async () => {
    let mode: 'down' | 'error' | 'rejected' = 'down';
    const s = setup(() => { if (mode === 'down') throw new TypeError('offline'); return res(mode === 'error' ? 503 : 401); });
    await s.tokens.setSession({ accessToken: 'old', refreshToken: 'r', expiresIn: 1 });
    s.clock.v += 5_000;
    await expect(s.tokens.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
    mode = 'error';
    await expect(s.tokens.getAccessToken()).rejects.toBeInstanceOf(NetworkError);
    expect(await s.tokens.hasSession()).toBe(true); // still signed in
    mode = 'rejected';
    await expect(s.tokens.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(await s.tokens.hasSession()).toBe(false); // cleared
    await expect(s.tokens.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('ApiClient', () => {
  it('refreshes once on 401 and retries the request with the new token', async () => {
    let valid = 'new';
    const s = setup((url, init) => {
      if (url.endsWith('/refresh')) return res(200, { accessToken: 'new', refreshToken: 'r2', expiresIn: 900 });
      return init?.headers?.Authorization === `Bearer ${valid}` ? res(200, { hello: 'world' }) : res(401);
    });
    await s.tokens.setSession({ accessToken: 'stale', refreshToken: 'r1', expiresIn: 900 });
    expect(await s.api.request('GET', '/v1/x')).toEqual({ hello: 'world' });
    expect(s.tokens.refreshCalls).toBe(1);
    expect(s.calls.map((c) => c.auth ?? 'refresh')).toEqual(['Bearer stale', 'refresh', 'Bearer new']);
    valid = 'never'; // a second 401 after refreshing means the session is really gone
    await expect(s.api.request('GET', '/v1/x')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('coalesces concurrent 401s into one refresh', async () => {
    const s = setup(async (url, init) => {
      if (url.endsWith('/refresh')) { await new Promise((r) => setTimeout(r, 20)); return res(200, { accessToken: 'new', refreshToken: 'r2', expiresIn: 900 }); }
      return init?.headers?.Authorization === 'Bearer new' ? res(200, {}) : res(401);
    });
    await s.tokens.setSession({ accessToken: 'stale', refreshToken: 'r1', expiresIn: 900 });
    await Promise.all(Array.from({ length: 6 }, () => s.api.request('GET', '/v1/x')));
    expect(s.tokens.refreshCalls).toBe(1);
  });

  it('maps transport failures and HTTP errors to the errors the sync engine understands', async () => {
    let mode: 'offline' | '400' | '204' = 'offline';
    const s = setup(() => { if (mode === 'offline') throw new TypeError('Network request failed'); return res(mode === '204' ? 204 : 400, { message: 'bad' }); });
    await s.tokens.setSession({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    await expect(s.api.request('GET', '/x')).rejects.toBeInstanceOf(NetworkError);
    mode = '400';
    await expect(s.api.request('POST', '/x', {})).rejects.toMatchObject({ status: 400, body: { message: 'bad' } });
    await expect(s.api.request('POST', '/x', {})).rejects.toBeInstanceOf(HttpError);
    mode = '204';
    expect(await s.api.request('POST', '/x', {})).toBeNull();
  });

  it('never puts the token in the URL', async () => {
    const s = setup(() => res(200, {}));
    await s.tokens.setSession({ accessToken: 'SECRET-TOKEN', refreshToken: 'r', expiresIn: 900 });
    await s.api.request('GET', '/v1/sync/reference?since=2026-01-01');
    expect(s.calls[0].url).not.toContain('SECRET-TOKEN');
  });
});

describe('ReferenceCache', () => {
  it('merges customers incrementally, applies tombstones, and keeps the last data when offline', async () => {
    const storage = new MemoryOutboxStorage();
    const transport = new FakeTransport();
    const cache = new ReferenceCache(storage, transport);
    const base = { serverTime: 't1', cursor: 'c1', incremental: false, farmId: 'f', businessDate: '2026-07-01', settings: {}, units: [{ code: 'EGG', eggsPerUnit: 1 }] };
    transport.referenceData = { ...base, customers: [
      { id: 'a', name: 'Alhaji', phone: null, type: 'REGULAR', version: 1, clientId: null }, { id: 'b', name: 'Binta', phone: null, type: 'REGULAR', version: 1, clientId: null },
    ] };
    const first = await cache.refresh();
    expect(first.customers.map((c) => c.name)).toEqual(['Alhaji', 'Binta']);
    transport.referenceData = { ...base, cursor: 'c2', customers: [{ id: 'b', deleted: true }, { id: 'c', name: 'Amie', phone: null, type: 'REGULAR', version: 1, clientId: null }, { id: 'a', name: 'Alhaji Bah', phone: null, type: 'REGULAR', version: 2, clientId: null }] };
    const second = await cache.refresh();
    expect(second.customers.map((c) => c.name)).toEqual(['Alhaji Bah', 'Amie']);
    expect(second.cursor).toBe('c2');
    transport.referenceData = undefined; // offline / server down
    await expect(cache.refresh()).rejects.toBeDefined();
    expect((await cache.load())?.customers).toHaveLength(2); // stale cache still usable
  });
});
