import { AuthRequiredError, HttpError, NetworkError } from '../sync/types';
import { TokenManager } from './token-manager';

type FetchLike = ConstructorParameters<typeof TokenManager>[2];

/** JSON API client: bearer auth, one automatic refresh-and-retry on 401, timeouts, and errors the sync engine understands. */
export class ApiClient {
  constructor(
    private readonly baseUrl: string, private readonly tokens: TokenManager, private readonly fetchImpl: FetchLike,
    private readonly deviceHeaders: Record<string, string> = {}, private readonly timeoutMs = 20_000,
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let token = await this.tokens.getAccessToken(); // may throw AuthRequiredError / NetworkError
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.send(method, path, token, body);
      if (res.status === 401 && attempt === 0) { token = await this.tokens.refresh(); continue; }
      if (res.status === 401) { await this.tokens.clear(); throw new AuthRequiredError(); }
      if (!res.ok) throw new HttpError(res.status, await res.json().catch(() => null));
      return (res.status === 204 ? null : await res.json()) as T;
    }
    throw new AuthRequiredError();
  }

  private async send(method: string, path: string, token: string, body?: unknown) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : undefined;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, signal: ctl?.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...this.deviceHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NetworkError(); // offline, DNS, TLS, timeout — all transient
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
