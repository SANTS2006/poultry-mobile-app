import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream } from 'fs';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/** Where encrypted dumps live: Cloudflare R2 only. Implementations only ever see already-encrypted files. */
export interface BackupStorage {
  /** Short label shown to administrators ("Cloudflare R2 · bucket"). Contains no credentials. */
  readonly label: string;
  put(key: string, file: string): Promise<void>;
  get(key: string, dest: string): Promise<void>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface R2Options { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; prefix: string }

/** Cloudflare R2 through its S3-compatible API. */
export class R2Storage implements BackupStorage {
  readonly label: string;
  private readonly client: S3Client;
  constructor(private readonly o: R2Options) {
    this.label = `Cloudflare R2 · ${o.bucket}`;
    this.client = new S3Client({
      region: 'auto', endpoint: o.endpoint, forcePathStyle: true,
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
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket })); return { ok: true }; } catch { return { ok: false, detail: 'The Cloudflare R2 bucket is not reachable with the configured credentials' }; }
  }
}
