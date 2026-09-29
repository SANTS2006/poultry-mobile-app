import type { OutboxItem, OutboxStatus } from './types';

/** Durable local storage for the outbox and small key/value data. Implementations: SQLite (device), in-memory (tests). */
export interface OutboxStorage {
  insert(item: Omit<OutboxItem, 'seq'>): Promise<OutboxItem>;
  update(clientId: string, patch: Partial<Omit<OutboxItem, 'clientId' | 'seq'>>): Promise<OutboxItem | null>;
  get(clientId: string): Promise<OutboxItem | null>;
  /** ordered by seq ascending */
  list(filter?: { statuses?: OutboxStatus[] }): Promise<OutboxItem[]>;
  remove(clientId: string): Promise<void>;
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
}

export class MemoryOutboxStorage implements OutboxStorage {
  private items = new Map<string, OutboxItem>();
  private kv = new Map<string, string>();
  private seq = 0;

  async insert(item: Omit<OutboxItem, 'seq'>): Promise<OutboxItem> {
    if (this.items.has(item.clientId)) throw new Error('duplicate client id');
    const row: OutboxItem = structuredClone({ ...item, seq: ++this.seq });
    this.items.set(row.clientId, row);
    return structuredClone(row);
  }
  async update(clientId: string, patch: Partial<Omit<OutboxItem, 'clientId' | 'seq'>>): Promise<OutboxItem | null> {
    const cur = this.items.get(clientId);
    if (!cur) return null;
    const next = { ...cur, ...structuredClone(patch) };
    this.items.set(clientId, next);
    return structuredClone(next);
  }
  async get(clientId: string): Promise<OutboxItem | null> { const r = this.items.get(clientId); return r ? structuredClone(r) : null; }
  async list(filter?: { statuses?: OutboxStatus[] }): Promise<OutboxItem[]> {
    return [...this.items.values()].filter((i) => !filter?.statuses || filter.statuses.includes(i.status)).sort((a, b) => a.seq - b.seq).map((i) => structuredClone(i));
  }
  async remove(clientId: string): Promise<void> { this.items.delete(clientId); }
  async getKv(key: string): Promise<string | null> { return this.kv.get(key) ?? null; }
  async setKv(key: string, value: string): Promise<void> { this.kv.set(key, value); }
}
