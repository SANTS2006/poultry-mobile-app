import type { OutboxStorage } from './storage';
import type { OutboxItem, OutboxStatus } from './types';

/** Minimal async SQL surface. On a device it is backed by expo-sqlite; in tests by node:sqlite. */
export interface SqlDriver {
  run(sql: string, params?: (string | number | null)[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
}

interface Row {
  seq: number; client_id: string; type: string; payload: string; status: string; attempts: number; created_at: string; updated_at: string;
  next_attempt_at: string | null; last_error: string | null; entity_id: string | null; synced_at: string | null;
}

const toItem = (r: Row): OutboxItem => ({
  seq: r.seq, clientId: r.client_id, type: r.type as OutboxItem['type'], payload: JSON.parse(r.payload) as Record<string, unknown>,
  status: r.status as OutboxStatus, attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at, nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error ? (JSON.parse(r.last_error) as OutboxItem['lastError']) : null, entityId: r.entity_id, syncedAt: r.synced_at,
});

/**
 * Durable outbox in SQLite. A record written here survives app kills, crashes and restarts. On a device, open the database with
 * SQLCipher (expo-sqlite `useSQLCipher`) and keep the key in the platform secure store so the file is encrypted at rest.
 */
export class SqliteOutboxStorage implements OutboxStorage {
  constructor(private readonly db: SqlDriver) {}

  async init(): Promise<void> {
    await this.db.run(`CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_attempt_at TEXT, last_error TEXT,
      entity_id TEXT, synced_at TEXT)`);
    await this.db.run('CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status)');
    await this.db.run('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async insert(i: Omit<OutboxItem, 'seq'>): Promise<OutboxItem> {
    await this.db.run(
      'INSERT INTO outbox (client_id, type, payload, status, attempts, created_at, updated_at, next_attempt_at, last_error, entity_id, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [i.clientId, i.type, JSON.stringify(i.payload), i.status, i.attempts, i.createdAt, i.updatedAt, i.nextAttemptAt, i.lastError ? JSON.stringify(i.lastError) : null, i.entityId, i.syncedAt],
    );
    return (await this.get(i.clientId)) as OutboxItem;
  }

  async update(clientId: string, patch: Partial<Omit<OutboxItem, 'clientId' | 'seq'>>): Promise<OutboxItem | null> {
    const cur = await this.get(clientId);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    await this.db.run(
      'UPDATE outbox SET payload=?, status=?, attempts=?, updated_at=?, next_attempt_at=?, last_error=?, entity_id=?, synced_at=? WHERE client_id=?',
      [JSON.stringify(n.payload), n.status, n.attempts, n.updatedAt, n.nextAttemptAt, n.lastError ? JSON.stringify(n.lastError) : null, n.entityId, n.syncedAt, clientId],
    );
    return this.get(clientId);
  }

  async get(clientId: string): Promise<OutboxItem | null> {
    const rows = await this.db.all<Row>('SELECT * FROM outbox WHERE client_id = ?', [clientId]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async list(filter?: { statuses?: OutboxStatus[] }): Promise<OutboxItem[]> {
    const st = filter?.statuses;
    const rows = st?.length
      ? await this.db.all<Row>(`SELECT * FROM outbox WHERE status IN (${st.map(() => '?').join(',')}) ORDER BY seq ASC`, st)
      : await this.db.all<Row>('SELECT * FROM outbox ORDER BY seq ASC');
    return rows.map(toItem);
  }

  async remove(clientId: string): Promise<void> { await this.db.run('DELETE FROM outbox WHERE client_id = ?', [clientId]); }
  async getKv(key: string): Promise<string | null> { return (await this.db.all<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]))[0]?.value ?? null; }
  async setKv(key: string, value: string): Promise<void> { await this.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]); }
}
