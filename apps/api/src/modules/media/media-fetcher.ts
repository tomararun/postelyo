import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  imageDimensions,
  sniffImageMime,
  SUPPORTED_IMAGE_MIMES,
  type ImageMime,
} from './image-meta.js';

/**
 * Downloads and validates an image from a URL supplied by the content source.
 * URLs are user-controlled (Notion external links), so the fetcher refuses
 * non-http(s) schemes and private/loopback hosts (SSRF guard, security.md §8).
 */

export type MediaErrorCode =
  | 'invalid_url'
  | 'blocked_url'
  | 'not_found'
  | 'expired'
  | 'too_large'
  | 'not_an_image'
  | 'unsupported_type'
  | 'network';

export class MediaError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface FetchedImage {
  bytes: Uint8Array;
  mimeType: ImageMime;
  byteSize: number;
  contentHash: string;
  width: number | null;
  height: number | null;
}

export interface MediaFetcherOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  allowedMimes?: readonly ImageMime[];
}

export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.lan'];

/** Throws MediaError when the URL must not be fetched from the worker. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaError('invalid_url', 'Media URL is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MediaError('blocked_url', `Media URL scheme ${url.protocol} is not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new MediaError('blocked_url', 'Media URL points to a local host');
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new MediaError('blocked_url', 'Media URL points to a private network address');
  }
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('::ffff:127.') ||
    v6.startsWith('::ffff:10.') ||
    v6.startsWith('::ffff:192.168.')
  );
}

export class MediaFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly allowed: readonly ImageMime[];

  constructor(opts: MediaFetcherOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.allowed = opts.allowedMimes ?? SUPPORTED_IMAGE_MIMES;
  }

  async fetchImage(raw: string): Promise<FetchedImage> {
    const url = assertFetchableUrl(raw);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MediaError('network', `Could not download media: ${(err as Error).message}`);
    }
    if (res.status === 403 || res.status === 401) {
      // Notion-hosted file URLs are signed and expire; the caller may refresh and retry.
      throw new MediaError(
        'expired',
        'Media URL is no longer accessible (expired or forbidden)',
        res.status,
      );
    }
    if (res.status === 404 || res.status === 410) {
      throw new MediaError('not_found', 'Media file was not found', res.status);
    }
    if (!res.ok) {
      throw new MediaError('network', `Media download failed with HTTP ${res.status}`, res.status);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new MediaError(
        'too_large',
        `Image is ${formatBytes(declared)}; the limit is ${formatBytes(this.maxBytes)}`,
      );
    }
    const bytes = await this.readCapped(res);
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) throw new MediaError('not_an_image', 'The media file is not a recognised image');
    if (!this.allowed.includes(mimeType)) {
      throw new MediaError(
        'unsupported_type',
        `Image type ${mimeType} is not supported; use JPEG or PNG`,
      );
    }
    const dims = imageDimensions(bytes, mimeType);
    return {
      bytes,
      mimeType,
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    };
  }

  /** Reads the body but aborts as soon as the cap is exceeded, even without content-length. */
  private async readCapped(res: Response): Promise<Uint8Array> {
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader: ReadableStreamDefaultReader<Uint8Array> = (
      res.body as ReadableStream<Uint8Array>
    ).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MediaError('too_large', `Image exceeds the ${formatBytes(this.maxBytes)} limit`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
