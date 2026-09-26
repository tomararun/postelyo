import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertStorageKey, type ObjectStorage, type StoredObject } from './object-storage.js';

export interface S3StorageConfig {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** When the bucket is public (or behind a CDN/custom domain), URLs are `<base>/<key>` and never expire. */
  publicBaseUrl?: string | undefined;
  /** R2 and MinIO need path-style addressing. */
  forcePathStyle?: boolean | undefined;
}

/** S3-compatible storage: Cloudflare R2 in production, MinIO or AWS elsewhere. */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly cfg: S3StorageConfig) {
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: assertStorageKey(key),
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, byteSize: bytes.byteLength, contentType };
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.cfg.bucket, Key: assertStorageKey(key) }),
      );
      const bytes = res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
      return { bytes, contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: assertStorageKey(key) }),
    );
  }

  async publicUrl(key: string, expiresInSeconds: number): Promise<string> {
    assertStorageKey(key);
    if (this.cfg.publicBaseUrl) return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
