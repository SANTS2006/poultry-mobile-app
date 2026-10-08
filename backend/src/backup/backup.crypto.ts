import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { stat, unlink } from 'fs/promises';
import { Readable, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Backup file layout:  "MKBK1" (5 bytes) | IV (12) | AES-256-GCM ciphertext | auth tag (16).
 * The job id is bound in as additional authenticated data, so an encrypted dump cannot be swapped for another job's file unnoticed.
 */
const MAGIC = Buffer.from('MKBK1');
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + IV_LEN;

const aad = (jobId: string) => Buffer.from(`makarifor-backup-v1:${jobId}`);

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

/** Streams plaintext in, writes header + ciphertext, and appends the auth tag when the stream ends. */
export class EncryptStream extends Transform {
  private readonly cipher;
  private started = false;
  private readonly iv = randomBytes(IV_LEN);
  constructor(key: Buffer, jobId: string) {
    super();
    this.cipher = createCipheriv('aes-256-gcm', key, this.iv);
    this.cipher.setAAD(aad(jobId));
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.started) { this.started = true; this.push(Buffer.concat([MAGIC, this.iv])); }
    cb(null, this.cipher.update(chunk));
  }
  override _flush(cb: TransformCallback): void {
    if (!this.started) this.push(Buffer.concat([MAGIC, this.iv]));
    this.push(this.cipher.final());
    this.push(this.cipher.getAuthTag());
    cb();
  }
}

/** Passes bytes through unchanged while hashing them (so the checksum is of exactly what was stored). */
export class HashTap extends Transform {
  private readonly h = createHash('sha256');
  bytes = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.h.update(chunk); this.bytes += chunk.length; cb(null, chunk);
  }
  digest(): string { return this.h.digest('hex'); }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), async function* (src) { for await (const c of src) { h.update(c as Buffer); } yield* []; });
  return h.digest('hex');
}

/** Decrypts `src` into `dest`. Throws (and removes `dest`) when the file is truncated, tampered with, or the key/job is wrong. */
export async function decryptFile(src: string, dest: string, key: Buffer, jobId: string): Promise<void> {
  const size = (await stat(src)).size;
  if (size < HEADER_LEN + TAG_LEN) throw new Error('Backup file is too small to be valid');
  const head = await readRange(src, 0, HEADER_LEN - 1);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Makarifor backup file');
  const iv = head.subarray(MAGIC.length);
  const tag = await readRange(src, size - TAG_LEN, size - 1);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(jobId));
  decipher.setAuthTag(tag);
  try {
    const body = size - TAG_LEN - HEADER_LEN;
    const source = body > 0 ? createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }) : Readable.from([]);
    await pipeline(source, decipher, createWriteStream(dest, { mode: 0o600 }));
  } catch {
    await unlink(dest).catch(() => undefined);
    throw new Error('Backup failed its authenticity check (wrong key, wrong job, or the file was altered)');
  }
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of createReadStream(path, { start, end })) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
