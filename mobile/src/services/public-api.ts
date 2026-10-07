import { HttpError, NetworkError } from '../sync/types';
import type { FetchLike } from './token-manager';

/** Unauthenticated JSON calls (login, MFA, password reset). Bearer-authenticated calls go through ApiClient. */
export class PublicApi {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike, private readonly headers: Record<string, string> = {}, private readonly timeoutMs = 20_000) {}

  async post<T = unknown>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : undefined;
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST', signal: ctl?.signal, headers: { 'Content-Type': 'application/json', ...this.headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NetworkError();
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new HttpError(res.status, await res.json().catch(() => null));
    return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  }
}
