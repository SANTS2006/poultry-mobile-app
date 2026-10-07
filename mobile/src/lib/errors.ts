import { AuthRequiredError, HttpError, NetworkError } from '../sync/types';

/** Turns any failure into text a farm worker can act on. Server messages are already client-safe; anything else is generic. */
export function describeError(e: unknown): string {
  if (e instanceof NetworkError) return 'No connection to the server. Check your internet and try again.';
  if (e instanceof AuthRequiredError) return 'Your session has ended. Please sign in again.';
  if (e instanceof HttpError) {
    const body = e.body as { message?: string | string[] } | null;
    const msg = Array.isArray(body?.message) ? body?.message.join(' ') : body?.message;
    if (msg) return msg;
    if (e.status === 403) return 'You do not have permission to do this.';
    if (e.status === 404) return 'That record was not found.';
    if (e.status === 429) return 'Too many attempts. Please wait a minute and try again.';
    if (e.status >= 500) return 'The server had a problem. Please try again shortly.';
  }
  if (e instanceof Error && e.name === 'OfflineValidationError') return e.message;
  return 'Something went wrong. Please try again.';
}

export const isHttp = (e: unknown, status?: number): e is HttpError => e instanceof HttpError && (status === undefined || e.status === status);
