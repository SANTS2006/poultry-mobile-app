import { QueryClient } from '@tanstack/react-query';
import { clearPersistedQueries, restoreQueries, startPersistingQueries, type KvStore } from './query-persist';

class Mem implements KvStore {
  m = new Map<string, string>();
  async getKv(k: string) { return this.m.get(k) ?? null; }
  async setKv(k: string, v: string) { this.m.set(k, v); }
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('query persistence', () => {
  it('saves the answers worth keeping and restores them for the same user', async () => {
    const kv = new Mem();
    const a = client();
    const stop = startPersistingQueries(a, kv, 'u1', 5);
    a.setQueryData(['dashboard'], { production: { todayEggs: 120 } });
    a.setQueryData(['sales', 'list'], { pages: [{ items: [{ id: 's1' }] }], pageParams: [1] });
    await flush(); stop();

    const b = client();
    expect(await restoreQueries(b, kv, 'u1')).toBe(true);
    expect(b.getQueryData(['dashboard'])).toEqual({ production: { todayEggs: 120 } });
    expect(b.getQueryData(['sales', 'list'])).toBeDefined();
  });

  it('never keeps admin, account or other private-by-nature queries', async () => {
    const kv = new Mem();
    const a = client();
    const stop = startPersistingQueries(a, kv, 'u1', 5);
    a.setQueryData(['admin', 'users'], { secret: 1 });
    a.setQueryData(['account', 'sessions'], { secret: 2 });
    a.setQueryData(['dashboard'], { ok: true });
    await flush(); stop();
    const raw = kv.m.get('cache.queries.v1')!;
    expect(raw).toContain('dashboard');
    expect(raw).not.toContain('secret');
  });

  it('shows nothing to a different user, ignores old or damaged caches, and can be wiped', async () => {
    const kv = new Mem();
    const a = client();
    const stop = startPersistingQueries(a, kv, 'u1', 5);
    a.setQueryData(['dashboard'], { ok: true });
    await flush(); stop();

    expect(await restoreQueries(client(), kv, 'u2')).toBe(false);
    expect(await restoreQueries(client(), kv, 'u1', Date.now() + 4 * 24 * 3600_000)).toBe(false);
    kv.m.set('cache.queries.v1', '{not json');
    expect(await restoreQueries(client(), kv, 'u1')).toBe(false);
    await clearPersistedQueries(kv);
    expect(await restoreQueries(client(), kv, 'u1')).toBe(false);
  });
});
