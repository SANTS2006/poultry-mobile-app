import { Prisma } from '@prisma/client';

/**
 * Connection settings that make a serverless database (Neon) behave on a real network:
 *  - connect_timeout 30 s (Prisma's default is 5 s, shorter than a Neon wake-up from sleep, which is what shows up as "P1001 can't reach database server");
 *  - pool_timeout 30 s (wait for a free connection instead of failing after 10 s while a slow wake-up holds them all);
 *  - pgbouncer=true for Neon's pooled host ("-pooler"), which Prisma needs there.
 * Anything you set yourself in DATABASE_URL wins.
 */
export function withConnectionDefaults(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', '30');
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', '30');
    if (/-pooler\./.test(u.hostname) && !u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    return u.toString();
  } catch { return url; }
}

export const isNeonHost = (url: string | undefined): boolean => { try { return !!url && new URL(url).hostname.endsWith('neon.tech'); } catch { return false; } };

/**
 * "Could not reach the server at all" — the statement never ran, so running it again is always safe (P1001, P1002 and the initialisation variant).
 * With `includeClosed` also "the server closed the connection" (P1017), which is what an idle connection looks like after Neon put the database to
 * sleep: for a READ that is safe to repeat, but a write may or may not have been applied, so writes never use it.
 */
export function isConnectError(e: unknown, includeClosed = false): boolean {
  const codes = includeClosed ? ['P1001', 'P1002', 'P1017'] : ['P1001', 'P1002'];
  // The initialisation variant of "can't reach the server" sometimes carries no error code, only the message.
  if (e instanceof Prisma.PrismaClientInitializationError) return codes.includes(e.errorCode ?? '') || (!e.errorCode && /can't reach database server/i.test(e.message));
  return e instanceof Prisma.PrismaClientKnownRequestError && codes.includes(e.code);
}

/** Operations that only read, so repeating them can never change data. */
export const READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', '$queryRaw', '$queryRawUnsafe']);

const DELAYS_MS = [500, 1000, 2000, 4000];

/**
 * Runs `fn`, retrying (after 0.5, 1, 2 and 4 s) when the database could not be reached, e.g. while it wakes from sleep or the network blips.
 * `onRetry` runs before each retry: the service uses it to reset Prisma's connection pool, which otherwise keeps handing out dead connections
 * (every query failing with P1017) long after the database is back.
 */
export async function retryConnect<T>(fn: () => Promise<T>, delays: readonly number[] = DELAYS_MS, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), includeClosed = false, onRetry?: () => Promise<void>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isConnectError(e, includeClosed) || i >= delays.length) throw e;
      await sleep(delays[i]);
      if (onRetry) { try { await onRetry(); } catch { /* the next attempt reports the real problem */ } }
    }
  }
}
