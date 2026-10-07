import { createHash } from 'crypto';

/** Deterministic UUID derived from a client id + index, so one client request that creates several rows stays idempotent. */
export function deriveUuid(clientId: string, index: number): string {
  const h = createHash('sha256').update(`${clientId}:${index}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
