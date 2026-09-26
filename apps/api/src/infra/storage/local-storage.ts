import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertStorageKey,
  contentTypeFor,
  type ObjectStorage,
  type StoredObject,
} from './object-storage.js';

/**
 * Filesystem-backed storage for development and tests. Objects are public
 * through the api (`GET /media/<key>`); keys are content hashes, so the URL
 * space is unguessable but not secret. Not for multi-instance deployments.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;

  constructor(
    private readonly rootDir: string,
    /** Origin the api serves `/media/*` from, e.g. APP_BASE_URL. */
    private readonly baseUrl: string,
  ) {}

  private pathFor(key: string): string {
    return path.join(this.rootDir, ...assertStorageKey(key).split('/'));
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { key, byteSize: bytes.byteLength, contentType };
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const bytes = await readFile(this.pathFor(key));
      return { bytes: new Uint8Array(bytes), contentType: contentTypeFor(key) };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async publicUrl(key: string, _expiresInSeconds: number): Promise<string> {
    return `${this.baseUrl.replace(/\/$/, '')}/media/${assertStorageKey(key)}`;
  }
}
