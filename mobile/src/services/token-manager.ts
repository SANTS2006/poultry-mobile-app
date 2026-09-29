import { AuthRequiredError, NetworkError } from '../sync/types';

/** Platform secure storage (expo-secure-store on a device: Keychain / Keystore). Never AsyncStorage. */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySecureStore implements SecureStore {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

export interface SessionTokens { accessToken: string; refreshToken: string; expiresIn: number }
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const K = { access: 'auth.access', refresh: 'auth.refresh', expires: 'auth.expiresAt' } as const;
const REFRESH_MARGIN_MS = 30_000;

/**
 * Holds the session tokens in secure storage and refreshes them.
 * Refreshes are SINGLE-FLIGHT: however many requests notice an expired token at once, exactly one refresh call is made and all of
 * them use its result. (The server treats a reused refresh token as theft and signs the device out, so parallel refreshes would
 * log the user out.) A network failure during refresh keeps the session; only a definitive rejection ends it.
 */
export class TokenManager {
  private inflight: Promise<string> | null = null;
  refreshCalls = 0;

  constructor(
    private readonly store: SecureStore, private readonly baseUrl: string, private readonly fetchImpl: FetchLike,
    private readonly deviceHeaders: Record<string, string> = {}, private readonly now: () => number = Date.now,
  ) {}

  async setSession(t: SessionTokens): Promise<void> {
    await this.store.set(K.access, t.accessToken);
    await this.store.set(K.refresh, t.refreshToken);
    await this.store.set(K.expires, String(this.now() + t.expiresIn * 1000));
  }

  async clear(): Promise<void> { for (const k of Object.values(K)) await this.store.delete(k); }
  async hasSession(): Promise<boolean> { return (await this.store.get(K.refresh)) !== null; }

  /** A token valid for at least the next 30 s, refreshing first if needed. */
  async getAccessToken(): Promise<string> {
    const [token, exp] = [await this.store.get(K.access), Number(await this.store.get(K.expires))];
    if (token && exp - this.now() > REFRESH_MARGIN_MS) return token;
    return this.refresh();
  }

  /** Forces a refresh (after a 401). Concurrent callers share one request. */
  refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    const refreshToken = await this.store.get(K.refresh);
    if (!refreshToken) throw new AuthRequiredError();
    this.refreshCalls++;
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/auth/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...this.deviceHeaders }, body: JSON.stringify({ refreshToken }),
      });
    } catch {
      throw new NetworkError('cannot reach the server to refresh the session');
    }
    if (res.status === 401 || res.status === 400) { await this.clear(); throw new AuthRequiredError('session ended'); }
    if (!res.ok) throw new NetworkError(`refresh failed with HTTP ${res.status}`); // server trouble: keep the session, try later
    const body = (await res.json()) as SessionTokens;
    await this.setSession(body);
    return body.accessToken;
  }
}
