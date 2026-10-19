import { existsSync, createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { once } from 'events';
import { Client } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import { createGunzip } from 'zlib';

/**
 * Backup and restore of the whole database in plain Node (no pg_dump / pg_restore needed on the API host).
 *
 * Dump: ONE read-only REPEATABLE READ transaction (a single consistent snapshot, like pg_dump) in which every table is streamed with
 * COPY … TO STDOUT, which is lossless for every column type (numeric, timestamptz, jsonb, bytea, arrays, enums).
 * Restore: the schema is rebuilt by replaying the project's own migration files (the ones the backup says were applied), the data is loaded
 * with COPY … FROM STDIN, foreign keys are re-added afterwards (which validates every row) and sequences are set to where they were.
 *
 * Plain (before gzip + encryption) layout:  "MKDUMP1\n"  then frames  [type:1 byte][length:4 bytes big-endian][payload]
 *   H header JSON   T table start JSON {name, columns, rows}   D raw COPY text chunk   E table end   S sequences JSON   F footer JSON {tables:{name:rows}}
 */
export const DUMP_FORMAT = 'mkdump-1';
const MAGIC = Buffer.from('MKDUMP1\n');

export interface DumpHeader { format: 1; createdAt: string; serverVersion: string; schema: string; migrations: string[]; tables: { name: string; columns: string[] }[] }
export interface DumpSummary { tables: number; rows: number; migrations: string[]; serverVersion: string; createdAt: string }

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const frame = (type: string, payload: Buffer | string): Buffer => {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(5); head.write(type, 0, 'latin1'); head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

/** A pg connection config from a Prisma-style URL (Prisma-only parameters such as ?schema= are removed; the schema is returned separately). */
export function connectionOf(url: string): { config: { connectionString: string; application_name: string }; schema: string } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema') || 'public';
  for (const k of ['schema', 'channel_binding', 'pgbouncer', 'connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout']) u.searchParams.delete(k);
  return { config: { connectionString: u.toString(), application_name: 'makarifor-backup' }, schema };
}

/** Streams the dump. Closing the iterator (a timeout, a failed upload) rolls the snapshot back and closes the connection. */
export async function* dumpFrames(url: string): AsyncGenerator<Buffer> {
  const { config, schema } = connectionOf(url);
  const client = new Client(config);
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const serverVersion = (await client.query<{ v: string }>('SHOW server_version')).rows[0]?.v ?? '';
    const tableRows = (await client.query<{ name: string; columns: string[] }>(
      `SELECT c.relname AS name,
              array(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum) AS columns
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`, [schema])).rows;
    const hasMigrations = tableRows.some((t) => t.name === '_prisma_migrations');
    const migrations = hasMigrations
      ? (await client.query<{ migration_name: string }>(`SELECT migration_name FROM ${q(schema)}._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY started_at, migration_name`)).rows.map((r) => r.migration_name)
      : [];
    const header: DumpHeader = { format: 1, createdAt: new Date().toISOString(), serverVersion, schema, migrations, tables: tableRows };
    yield MAGIC;
    yield frame('H', JSON.stringify(header));

    const counts: Record<string, number> = {};
    for (const t of tableRows) {
      const declared = Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(schema)}.${q(t.name)}`)).rows[0]!.n);
      yield frame('T', JSON.stringify({ name: t.name, columns: t.columns, rows: declared }));
      let seen = 0;
      if (t.columns.length > 0) {
        const stream = copyTo(`COPY ${q(schema)}.${q(t.name)} (${t.columns.map(q).join(', ')}) TO STDOUT`);
        client.query(stream);
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) seen++; // one raw newline ends each row (newlines inside values are escaped)
          yield frame('D', chunk);
        }
      }
      if (seen !== declared) throw new Error(`Table ${t.name}: read ${seen} rows but the snapshot holds ${declared}.`);
      counts[t.name] = seen;
      yield frame('E', '');
    }
    const seqs = (await client.query<{ name: string }>(`SELECT s.relname AS name FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace WHERE n.nspname = $1 AND s.relkind = 'S' ORDER BY 1`, [schema])).rows;
    const sequences: { name: string; value: string; called: boolean }[] = [];
    for (const s of seqs) {
      const r = (await client.query<{ last_value: string; is_called: boolean }>(`SELECT last_value, is_called FROM ${q(schema)}.${q(s.name)}`)).rows[0]!;
      sequences.push({ name: s.name, value: String(r.last_value), called: r.is_called });
    }
    yield frame('S', JSON.stringify(sequences));
    yield frame('F', JSON.stringify({ tables: counts }));
    await client.query('COMMIT');
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────
interface Frame { type: string; payload: Buffer }

/** Reads frames from a gzip-compressed dump file. */
export async function* readFrames(path: string): AsyncGenerator<Frame> {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let magicChecked = false;
  const need = async function* (): AsyncGenerator<Buffer> { for await (const c of createReadStream(path).pipe(createGunzip()) as AsyncIterable<Buffer>) yield c; };
  for await (const chunk of need()) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!magicChecked) {
      if (buf.length < MAGIC.length) continue;
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This file is not a Makarifor database backup.');
      buf = buf.subarray(MAGIC.length); magicChecked = true;
    }
    for (;;) {
      if (buf.length < 5) break;
      const len = buf.readUInt32BE(1);
      if (buf.length < 5 + len) break;
      yield { type: String.fromCharCode(buf[0]!), payload: buf.subarray(5, 5 + len) };
      buf = buf.subarray(5 + len);
    }
  }
  if (!magicChecked || buf.length > 0) throw new Error('The backup file is truncated.');
}

/** Reads the whole dump without a database and proves it is complete and internally consistent (row counts, footer). */
export async function inspectDump(path: string): Promise<DumpSummary> {
  let header: DumpHeader | null = null; let footer: { tables: Record<string, number> } | null = null;
  let current: { name: string; rows: number; seen: number } | null = null;
  const done: Record<string, number> = {};
  for await (const f of readFrames(path)) {
    if (f.type === 'H') header = JSON.parse(f.payload.toString()) as DumpHeader;
    else if (f.type === 'T') { const t = JSON.parse(f.payload.toString()) as { name: string; rows: number }; current = { name: t.name, rows: t.rows, seen: 0 }; }
    else if (f.type === 'D' && current) { for (let i = 0; i < f.payload.length; i++) if (f.payload[i] === 0x0a) current.seen++; }
    else if (f.type === 'E' && current) {
      if (current.seen !== current.rows) throw new Error(`Table ${current.name} is damaged: ${current.seen} of ${current.rows} rows present.`);
      done[current.name] = current.seen; current = null;
    } else if (f.type === 'F') footer = JSON.parse(f.payload.toString()) as { tables: Record<string, number> };
  }
  if (!header || !footer || current) throw new Error('The backup is incomplete (it ends before its footer).');
  for (const t of header.tables) if (done[t.name] !== footer.tables[t.name]) throw new Error(`Table ${t.name} is missing from the backup.`);
  return { tables: header.tables.length, rows: Object.values(done).reduce((a, b) => a + b, 0), migrations: header.migrations, serverVersion: header.serverVersion, createdAt: header.createdAt };
}

// ── restoring ───────────────────────────────────────────────────────────────────────────────────
export function migrationsDir(): string {
  const candidates = [process.env.MIGRATIONS_DIR, join(process.cwd(), 'prisma', 'migrations'), join(__dirname, '..', '..', 'prisma', 'migrations'), join(__dirname, '..', '..', '..', 'prisma', 'migrations')];
  const hit = candidates.find((d): d is string => !!d && existsSync(d));
  if (!hit) throw new Error('The migration files (backend/prisma/migrations) were not found next to the API, so the schema cannot be rebuilt. Set MIGRATIONS_DIR.');
  return hit;
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id VARCHAR(36) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT,
  rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`;

/** Loads a dump into an EMPTY database (`url`), in schema "public". Throws on the first problem; the caller drops the half-built database. */
export async function restoreDump(path: string, url: string): Promise<DumpSummary> {
  const { config } = connectionOf(url);
  const client = new Client(config);
  await client.connect();
  try {
    let header: DumpHeader | null = null;
    let fks: { tbl: string; name: string; def: string }[] = [];
    let ingest: ReturnType<typeof copyFrom> | null = null; let ingestError: Error | null = null; let ingestDone: Promise<unknown> | null = null;
    let current: { name: string; rows: number } | null = null; let rows = 0;
    const declared: Record<string, number> = {};
    let guarded: string[] = [];
    for await (const f of readFrames(path)) {
      if (f.type === 'H') {
        header = JSON.parse(f.payload.toString()) as DumpHeader;
        // 1. the schema: replay the same migration files the source database had applied
        const dir = migrationsDir();
        for (const name of header.migrations) {
          const file = join(dir, name, 'migration.sql');
          if (!existsSync(file)) throw new Error(`The backup was made with migration "${name}", which this version of the API does not have. Update the API code to the version that made the backup.`);
          await client.query(await readFile(file, 'utf8'));
        }
        await client.query(MIGRATIONS_TABLE);
        // 2. foreign keys off while loading (any table order works); they are put back — and every row checked — at the end
        fks = (await client.query<{ tbl: string; name: string; def: string }>(
          `SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)).rows;
        for (const k of fks) await client.query(`ALTER TABLE ${k.tbl} DROP CONSTRAINT ${q(k.name)}`);
        // 3. the migrations seed a few reference rows; the backup holds the real contents, so start every table empty (the append-only
        //    triggers of the audit log and stock ledger are paused for this and switched back on before the end)
        const all = header.tables.map((t) => `public.${q(t.name)}`);
        for (const t of all) await client.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
        if (all.length) await client.query(`TRUNCATE ${all.join(', ')}`);
        guarded = all;
      } else if (f.type === 'T') {
        if (!header) throw new Error('The backup is damaged (no header).');
        const t = JSON.parse(f.payload.toString()) as { name: string; columns: string[]; rows: number };
        current = { name: t.name, rows: t.rows }; declared[t.name] = t.rows;
        if (t.columns.length === 0) continue;
        const stream = copyFrom(`COPY public.${q(t.name)} (${t.columns.map(q).join(', ')}) FROM STDIN`);
        client.query(stream);
        ingest = stream; ingestError = null;
        stream.on('error', (e: Error) => { ingestError = e; });
        ingestDone = once(stream, 'finish').catch(() => undefined);
      } else if (f.type === 'D' && ingest) {
        const w = ingest;
        if (ingestError) throw ingestError;
        if (!w.write(f.payload)) await once(w, 'drain');
      } else if (f.type === 'E' && current) {
        if (ingest) {
          ingest.end(); await ingestDone;
          if (ingestError) throw ingestError;
          const got = ingest.rowCount;
          if (got !== current.rows) throw new Error(`Table ${current.name}: loaded ${got} rows, expected ${current.rows}.`);
        }
        rows += current.rows; ingest = null; current = null;
      } else if (f.type === 'S') {
        for (const s of JSON.parse(f.payload.toString()) as { name: string; value: string; called: boolean }[]) {
          await client.query('SELECT setval($1::regclass, $2::bigint, $3)', [`public.${q(s.name)}`, s.value, s.called]);
        }
      }
    }
    if (!header) throw new Error('The backup is damaged (no header).');
    for (const t of guarded) await client.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
    for (const k of fks) await client.query(`ALTER TABLE ${k.tbl} ADD CONSTRAINT ${q(k.name)} ${k.def}`);
    return { tables: header.tables.length, rows, migrations: header.migrations, serverVersion: header.serverVersion, createdAt: header.createdAt };
  } finally {
    await client.end().catch(() => undefined);
  }
}
