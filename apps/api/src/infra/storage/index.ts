import path from 'node:path';
import type { Env } from '../../config/env.js';
import { LocalObjectStorage } from './local-storage.js';
import type { ObjectStorage } from './object-storage.js';
import { S3ObjectStorage } from './s3-storage.js';

export type { ObjectStorage, StoredObject } from './object-storage.js';
export { assertStorageKey, contentTypeFor, extensionFor } from './object-storage.js';
export { LocalObjectStorage } from './local-storage.js';
export { S3ObjectStorage } from './s3-storage.js';

/** Storage from the environment: `s3` needs the S3_* variables (validated in env.ts). */
export function createStorage(
  env: Pick<
    Env,
    | 'STORAGE_DRIVER'
    | 'STORAGE_LOCAL_DIR'
    | 'APP_BASE_URL'
    | 'S3_ENDPOINT'
    | 'S3_REGION'
    | 'S3_BUCKET'
    | 'S3_ACCESS_KEY_ID'
    | 'S3_SECRET_ACCESS_KEY'
    | 'S3_PUBLIC_BASE_URL'
  >,
): ObjectStorage {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3ObjectStorage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'auto',
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
    });
  }
  return new LocalObjectStorage(path.resolve(env.STORAGE_LOCAL_DIR), env.APP_BASE_URL);
}
