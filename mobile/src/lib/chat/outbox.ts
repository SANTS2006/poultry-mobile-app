import type { PendingMessage } from './types';

const MAX_PENDING = 100;

/** Unsent messages are kept on the phone (in the encrypted database) so a restart or a bad network never loses what someone typed. */
export function serializePending(list: readonly PendingMessage[]): string {
  return JSON.stringify(list.slice(-MAX_PENDING).map((p) => ({ ...p, status: 'failed' as const }))); // after a restart nothing is "sending": offer Retry
}
export function parsePending(raw: string | null): PendingMessage[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is PendingMessage => !!p && typeof p.clientId === 'string' && typeof p.conversationId === 'string' && typeof p.kind === 'string' && typeof p.createdAt === 'string').slice(-MAX_PENDING);
  } catch { return []; }
}

/** Exponential back-off with a cap: 1 s, 2 s, 4 s … 30 s. */
export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));

/** A failure worth retrying automatically (network, server busy, rate limit) versus one the user must fix (validation, permission, blocked). */
export function isRetryable(status: number | null): boolean { return status === null || status === 408 || status === 429 || status >= 500; }
