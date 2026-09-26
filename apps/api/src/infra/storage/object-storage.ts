/**
 * Object storage behind an interface (architecture §9.3 media pipeline, Phase 2).
 * Keys are content-addressed (`ws/<workspace>/<sha256>[-<variant>].<ext>`), so
 * puts are idempotent and safe to retry. Implementations: S3-compatible
 * (Cloudflare R2 in production) and a local filesystem store for development
 * and tests, served by the api at `/media/<key>`.
 */

export interface StoredObject {
  key: string;
  byteSize: number;
  contentType: string;
}

export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  /** Bytes of a stored object; null when missing. */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
  /** Publicly reachable URL, valid at least `expiresInSeconds` (providers fetch it once). */
  publicUrl(key: string, expiresInSeconds: number): Promise<string>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,254}$/;

/** Keys never contain `..`, leading slashes or characters outside a small safe set. */
export function assertStorageKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`invalid storage key: ${key}`);
  }
  return key;
}

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function contentTypeFor(key: string): string {
  const ext = key.split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
    }[ext] ?? 'application/octet-stream'
  );
}
