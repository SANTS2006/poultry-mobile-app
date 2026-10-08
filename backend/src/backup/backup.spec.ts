import { randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { parseEnv } from '../config/env';
import { decryptFile, EncryptStream, HashTap, sha256File } from './backup.crypto';
import { LocalStorage } from './backup.storage';
import { selectExpired, type RetentionJob } from './backup.retention';
import { databaseOf, describeTarget, pgEnv, withDatabase } from './pg-tools';

const key = randomBytes(32);

describe('backup encryption', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bk-spec-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function encrypt(plain: Buffer, jobId: string) {
    const enc = join(dir, 'f.enc'); const tap = new HashTap();
    await pipeline(Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]), new EncryptStream(key, jobId), tap, createWriteStream(enc));
    return { enc, sha: tap.digest() };
  }

  it('round-trips large data and the checksum is of the stored (encrypted) bytes', async () => {
    const plain = randomBytes(300_000);
    const { enc, sha } = await encrypt(plain, 'job-1');
    expect(await sha256File(enc)).toBe(sha);
    const out = join(dir, 'f.plain');
    await decryptFile(enc, out, key, 'job-1');
    expect((await readFile(out)).equals(plain)).toBe(true);
    expect((await readFile(enc)).includes(plain.subarray(0, 64))).toBe(false); // not stored in clear
  });

  it('refuses a wrong key, a different job id, a flipped byte and a truncated file (and leaves no plaintext)', async () => {
    const { enc } = await encrypt(randomBytes(5000), 'job-1');
    const out = join(dir, 'o');
    await expect(decryptFile(enc, out, randomBytes(32), 'job-1')).rejects.toThrow(/authenticity/);
    await expect(decryptFile(enc, out, key, 'job-2')).rejects.toThrow(/authenticity/);
    const bytes = await readFile(enc);
    const flipped = Buffer.from(bytes); flipped[100] ^= 1;
    await writeFile(join(dir, 'flip'), flipped);
    await expect(decryptFile(join(dir, 'flip'), out, key, 'job-1')).rejects.toThrow(/authenticity/);
    await writeFile(join(dir, 'trunc'), bytes.subarray(0, bytes.length - 20));
    await expect(decryptFile(join(dir, 'trunc'), out, key, 'job-1')).rejects.toThrow();
    await writeFile(join(dir, 'tiny'), Buffer.from('x'));
    await expect(decryptFile(join(dir, 'tiny'), out, key, 'job-1')).rejects.toThrow(/too small/);
    await expect(readFile(out)).rejects.toThrow(); // nothing left behind
  });

  it('encrypts an empty stream into a valid (decryptable) file', async () => {
    const { enc } = await encrypt(Buffer.alloc(0), 'j');
    await decryptFile(enc, join(dir, 'e'), key, 'j');
    expect((await readFile(join(dir, 'e'))).length).toBe(0);
  });

  it('local storage cannot be tricked into leaving its folder', async () => {
    const s = new LocalStorage(join(dir, 'store'));
    const src = join(dir, 'src'); await writeFile(src, 'x');
    await expect(s.put('../escape', src)).rejects.toThrow(/Invalid storage key/);
    await s.put('a/b.enc', src);
    expect(await s.exists('a/b.enc')).toBe(true);
    await s.delete('a/b.enc'); await s.delete('a/b.enc'); // deleting twice is fine
    expect(await s.exists('a/b.enc')).toBe(false);
    void createReadStream; // (imported for symmetry with the storage API)
  });
});

describe('retention policy', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const job = (id: string, daysAgo: number, o: Partial<RetentionJob> = {}): RetentionJob =>
    ({ id, kind: 'SCHEDULED', status: 'SUCCESSFUL', verification: 'NOT_VERIFIED', deletedAt: null, createdAt: new Date(now.getTime() - daysAgo * 86_400_000), ...o });

  it('keeps recent backups, deletes old ones', () => {
    const jobs = [job('new', 1), job('mid', 13), job('old', 40), job('older', 41)];
    // monthly keeper: newest of each of the last N months is retained even when old
    expect(selectExpired(jobs, now, { retentionDays: 14, keepMonthly: 0 }).sort()).toEqual(['old', 'older']);
  });
  it('always keeps the newest successful and the newest verified backup, however old', () => {
    const jobs = [job('only', 400), job('v', 500, { verification: 'VERIFIED' })];
    expect(selectExpired(jobs, now, { retentionDays: 7, keepMonthly: 0 })).toEqual([]);
  });
  it('keeps one backup per month for the configured number of months', () => {
    const jobs = [job('oct', 1), job('sep-late', 20), job('sep-early', 30), job('aug', 55), job('jul', 80)];
    const gone = selectExpired(jobs, now, { retentionDays: 7, keepMonthly: 2 });
    expect(gone).toEqual(expect.arrayContaining(['sep-early', 'aug', 'jul']));
    expect(gone).not.toContain('oct'); expect(gone).not.toContain('sep-late');
  });
  it('never touches failed, running or already-deleted rows; pre-restore snapshots live 30 days', () => {
    const jobs = [job('ok', 0), job('failed', 99, { status: 'FAILED' }), job('run', 99, { status: 'RUNNING' }), job('gone', 99, { deletedAt: now }),
      job('snap-new', 20, { kind: 'PRE_RESTORE' }), job('snap-old', 31, { kind: 'PRE_RESTORE' })];
    expect(selectExpired(jobs, now, { retentionDays: 14, keepMonthly: 0 })).toEqual(['snap-old']);
  });
});

describe('postgres connection helpers', () => {
  it('passes credentials through the environment, not arguments', () => {
    const env = pgEnv('postgresql://me:p%40ss@db.example.com:6543/shop?sslmode=require&channel_binding=require');
    expect(env).toEqual({ PGHOST: 'db.example.com', PGPORT: '6543', PGUSER: 'me', PGPASSWORD: 'p@ss', PGDATABASE: 'shop', PGSSLMODE: 'require', PGCHANNELBINDING: 'require' });
  });
  it('describes a target without credentials and swaps database names', () => {
    expect(describeTarget('postgresql://me:secret@db.example.com/shop')).toBe('db.example.com:5432/shop');
    expect(describeTarget('postgresql://me:secret@db.example.com/shop')).not.toMatch(/secret/);
    expect(databaseOf(withDatabase('postgresql://u:p@h/postgres', 'recovery_x'))).toBe('recovery_x');
  });
});

describe('backup configuration', () => {
  const prod = {
    APP_ENV: 'production', DATABASE_URL: 'postgresql://u:p@h/db?sslmode=require', DIRECT_DATABASE_URL: 'postgresql://u:p@h/db?sslmode=require',
    JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    BREVO_API_KEY: 'k', EMAIL_FROM: 'a@b.co',
  };
  it('production accepts a missing key (backups stay off, with a warning) but rejects a bad or reused one', () => {
    expect(() => parseEnv(prod)).not.toThrow();
    expect(() => parseEnv({ ...prod, BACKUP_ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => parseEnv({ ...prod, BACKUP_ENCRYPTION_KEY: prod.DATA_ENCRYPTION_KEY })).toThrow(/must differ/);
    expect(() => parseEnv({ ...prod, BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') })).not.toThrow();
    expect(() => parseEnv({ ...prod, BACKUP_ENABLED: '0', BACKUP_ENCRYPTION_KEY: 'ignored' })).not.toThrow();
  });
  it('s3 storage needs its bucket and credentials', () => {
    expect(() => parseEnv({ ...prod, BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'), BACKUP_STORAGE: 's3' })).toThrow(/BACKUP_S3_BUCKET/);
  });
});
