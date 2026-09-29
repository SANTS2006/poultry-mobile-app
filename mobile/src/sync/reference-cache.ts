import type { OutboxStorage } from './storage';
import type { ReferenceData, SyncTransport } from './types';

type Customer = NonNullable<ReferenceData['customers']>[number];
export type CachedReference = Omit<ReferenceData, 'customers' | 'incremental'> & { customers: Extract<Customer, { name: string }>[] };
const KEY = 'reference.v1';

/**
 * Offline copy of the reference data (coops, units, prices, customers, stock…). Customers are merged incrementally using the server
 * cursor, with tombstones removing deleted ones. The cache is convenience only: the server re-validates and re-prices everything.
 */
export class ReferenceCache {
  constructor(private readonly storage: OutboxStorage, private readonly transport: SyncTransport) {}

  async load(): Promise<CachedReference | null> {
    const raw = await this.storage.getKv(KEY);
    return raw ? (JSON.parse(raw) as CachedReference) : null;
  }

  /** Fetches and merges. Throws transport errors unchanged so callers can keep using the stale cache when offline. */
  async refresh(): Promise<CachedReference> {
    const prev = await this.load();
    const data = await this.transport.reference(prev?.cursor);
    const customers = new Map((prev?.customers ?? []).map((c) => [c.id, c]));
    for (const c of data.customers ?? []) { if ('deleted' in c) customers.delete(c.id); else customers.set(c.id, c); }
    const { customers: _drop, incremental: _inc, ...rest } = data;
    void _drop; void _inc;
    const merged: CachedReference = { ...(prev ?? {}), ...rest, customers: [...customers.values()].sort((a, b) => a.name.localeCompare(b.name)) } as CachedReference;
    await this.storage.setKv(KEY, JSON.stringify(merged));
    return merged;
  }
}
