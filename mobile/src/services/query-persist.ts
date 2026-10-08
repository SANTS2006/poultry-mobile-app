import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';

/** The slice of the on-phone database this needs (the outbox storage provides it). */
export interface KvStore { getKv(key: string): Promise<string | null>; setKv(key: string, value: string): Promise<void> }

const KEY = 'cache.queries.v1';
const MAX_AGE_MS = 3 * 24 * 3600_000;
const MAX_CHARS = 1_500_000;
/** Screens that benefit from opening instantly. Admin, account/security and one-off detail queries are never kept. */
const KEEP = new Set(['dashboard', 'notifications', 'production', 'sales', 'customers', 'inventory', 'expenses', 'payments']);

interface Saved { userId: string; savedAt: number; state: DehydratedState }

/**
 * Remembers the last answers on the phone so the next start shows real numbers immediately (then refreshes in the background) instead of
 * waiting several seconds for the server. Belongs to one user: another user's answers are never shown, and signing out wipes them.
 */
export async function restoreQueries(qc: QueryClient, kv: KvStore, userId: string, now = Date.now()): Promise<boolean> {
  try {
    const raw = await kv.getKv(KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as Saved;
    if (saved.userId !== userId || now - saved.savedAt > MAX_AGE_MS) return false;
    hydrate(qc, saved.state);
    return true;
  } catch { return false; } // a damaged cache is just an empty cache
}

export async function clearPersistedQueries(kv: KvStore): Promise<void> {
  try { await kv.setKv(KEY, ''); } catch { /* nothing to clear */ }
}

/** Saves a snapshot a couple of seconds after the last change (never on every keystroke or realtime tick). Returns a stop function. */
export function startPersistingQueries(qc: QueryClient, kv: KvStore, userId: string, delayMs = 2000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = async () => {
    timer = null;
    try {
      const state = dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.status === 'success' && typeof q.queryKey[0] === 'string' && KEEP.has(q.queryKey[0]) });
      const json = JSON.stringify({ userId, savedAt: Date.now(), state } satisfies Saved);
      if (json.length <= MAX_CHARS) await kv.setKv(KEY, json);
    } catch { /* caching is an optimisation; never an error */ }
  };
  const unsubscribe = qc.getQueryCache().subscribe(() => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void save(); }, delayMs); });
  return () => { unsubscribe(); if (timer) clearTimeout(timer); };
}
