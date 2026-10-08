/**
 * Tiny in-memory cache with a time limit, for data that is read on almost every request and changes rarely (settings, unit table, the
 * farm record, a user's permissions). It removes database round trips, which are what make requests slow when the database is far away.
 *  • concurrent callers asking for the same missing key share ONE load;
 *  • everything can be cleared at once (`clear`), which the app does whenever the underlying data is known to have changed;
 *  • under Jest (JEST_WORKER_ID is set) the time limit is 0 (every read goes to the database) unless a test opts in with FORCE_CACHE=1, so tests keep checking real data.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  private get ttl(): number {
    return process.env.JEST_WORKER_ID !== undefined && !process.env.FORCE_CACHE ? 0 : this.ttlMs;
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const ttl = this.ttl;
    if (ttl <= 0) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const inflight = this.loading.get(key);
    if (inflight) return inflight;
    const p = load().then((value) => {
      this.entries.set(key, { value, expires: this.now() + ttl });
      return value;
    }).finally(() => { this.loading.delete(key); });
    this.loading.set(key, p);
    return p;
  }

  delete(key: string): void { this.entries.delete(key); }

  clear(): void { this.entries.clear(); }

  get size(): number { return this.entries.size; }
}
