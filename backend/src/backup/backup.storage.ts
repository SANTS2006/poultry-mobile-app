import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream } from 'fs';
import { copyFile, mkdir, stat, unlink } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/** Where encrypted dumps live. Implementations only ever see already-encrypted files. */
export interface BackupStorage {
  /** Short label shown to administrators ("local disk", "s3://bucket"). Contains no credentials. */
  readonly label: string;
  /** True when the copy survives the loss of the API server (an object store). Local disk does not. */
  readonly offsite: boolean;
  put(key: string, file: string): Promise<void>;
  get(key: string, dest: string): Promise<void>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class LocalStorage implements BackupStorage {
  readonly label = 'local disk'; readonly offsite = false;
  private readonly root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, file: string) { const p = this.path(key); await mkdir(dirname(p), { recursive: true, mode: 0o700 }); await copyFile(file, p); }
  async get(key: string, dest: string) { await copyFile(this.path(key), dest); }
  async stream(key: string) { await stat(this.path(key)); return createReadStream(this.path(key)); }
  async delete(key: string) { await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
  async exists(key: string) { return stat(this.path(key)).then(() => true, () => false); }
  async health() {
    try { await mkdir(this.root, { recursive: true, mode: 0o700 }); return { ok: true }; } catch { return { ok: false, detail: 'Backup folder is not writable' }; }
  }
}

export interface S3Options { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix: string }

export class S3Storage implements BackupStorage {
  readonly offsite = true;
  readonly label: string;
  private readonly client: S3Client;
  constructor(private readonly o: S3Options) {
    this.label = `s3://${o.bucket}`;
    this.client = new S3Client({
      region: o.region, ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    });
  }
  private k(key: string) { return `${this.o.prefix}${key}`; }
  async put(key: string, file: string) {
    await new Upload({ client: this.client, params: { Bucket: this.o.bucket, Key: this.k(key), Body: createReadStream(file), ContentType: 'application/octet-stream' } }).done();
  }
  async get(key: string, dest: string) { await pipeline(await this.stream(key), createWriteStream(dest, { mode: 0o600 })); }
  async stream(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) }));
    return r.Body as Readable;
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) })); }
  async exists(key: string) { return this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: this.k(key) })).then(() => true, () => false); }
  async health() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket })); return { ok: true }; } catch { return { ok: false, detail: 'Backup bucket is not reachable with the configured credentials' }; }
  }
}
