import { Readable } from 'stream';
import { readFile, writeFile } from 'fs/promises';
import type { BackupStorage } from '../src/backup/backup.storage';

/** In-memory stand-in for Cloudflare R2 so tests need no bucket and write nothing to disk. */
export class FakeR2 implements BackupStorage {
  readonly label = 'Cloudflare R2 · test-bucket';
  readonly blobs = new Map<string, Buffer>();
  async put(key: string, file: string) { this.blobs.set(key, await readFile(file)); }
  async get(key: string, dest: string) { const b = this.blobs.get(key); if (!b) throw new Error('NoSuchKey'); await writeFile(dest, b, { mode: 0o600 }); }
  async stream(key: string) { const b = this.blobs.get(key); if (!b) throw new Error('NoSuchKey'); return Readable.from([b]); }
  async delete(key: string) { this.blobs.delete(key); }
  async exists(key: string) { return this.blobs.has(key); }
  async health() { return { ok: true }; }
}
