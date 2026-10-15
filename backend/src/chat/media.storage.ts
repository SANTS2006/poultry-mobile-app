import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

/** Where chat files live (Cloudflare R2). The API only ever hands phones short-lived, single-purpose URLs. */
export interface MediaStorage {
  readonly configured: boolean;
  presignPut(key: string, mimeType: string, sizeBytes: number, ttlSeconds: number): Promise<string>;
  presignGet(key: string, fileName: string, mimeType: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ sizeBytes: number; mimeType?: string } | null>;
  delete(key: string): Promise<void>;
}

export interface MediaR2Options { accountId: string; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }

export class R2MediaStorage implements MediaStorage {
  readonly configured = true;
  private readonly client: S3Client;
  constructor(private readonly o: MediaR2Options) {
    this.client = new S3Client({ region: 'auto', endpoint: o.endpoint, forcePathStyle: true, credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey } });
  }
  presignPut(key: string, mimeType: string, sizeBytes: number, ttl: number) {
    // Content-Type and Content-Length are signed: the phone cannot upload a different type or a larger file with this URL.
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.o.bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes }), { expiresIn: ttl });
  }
  presignGet(key: string, fileName: string, mimeType: string, ttl: number) {
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.o.bucket, Key: key, ResponseContentType: mimeType, ResponseContentDisposition: `inline; filename="${fileName.replace(/[^\x20-\x7e]/g, '_')}"`,
    }), { expiresIn: ttl });
  }
  async head(key: string) {
    try { const r = await this.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key })); return { sizeBytes: Number(r.ContentLength ?? 0), mimeType: r.ContentType }; } catch { return null; }
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key })); }
}

/** Used when no bucket is configured: file sharing is switched off cleanly instead of failing at upload time. */
export class DisabledMediaStorage implements MediaStorage {
  readonly configured = false;
  private no(): never { throw new Error('File sharing is not configured'); }
  presignPut(): Promise<string> { return this.no(); }
  presignGet(): Promise<string> { return this.no(); }
  head(): Promise<null> { return this.no(); }
  delete(): Promise<void> { return this.no(); }
}
