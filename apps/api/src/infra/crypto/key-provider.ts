import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Master-key abstraction for envelope encryption (security.md §6.2, architecture §13).
 * The MVP implementation holds keys from the environment; a KMS-backed provider
 * is a drop-in replacement because only wrap/unwrap of 32-byte data keys is needed.
 */
export interface KeyProvider {
  readonly currentKeyId: string;
  /** Wraps a data-encryption key with the current master key. */
  wrap(dek: Buffer): { keyId: string; wrapped: Buffer };
  /** Unwraps with the master key identified by `keyId`; throws if unknown or tampered. */
  unwrap(keyId: string, wrapped: Buffer): Buffer;
}

export interface MasterKey {
  id: string;
  key: Buffer;
}

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class KeyProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyProviderError';
  }
}

/**
 * Parses `ENCRYPTION_KEYS="k2:<base64 32B>,k1:<base64 32B>"`. The first entry is
 * the current key; older keys stay listed until every row has been re-wrapped.
 */
export function parseEncryptionKeys(raw: string): MasterKey[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0)
    throw new KeyProviderError('ENCRYPTION_KEYS: at least one key required');
  const seen = new Set<string>();
  return entries.map((entry) => {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new KeyProviderError('ENCRYPTION_KEYS: expected "<id>:<base64>" entries');
    const id = entry.slice(0, idx);
    const b64 = entry.slice(idx + 1);
    if (!KEY_ID_RE.test(id)) throw new KeyProviderError(`ENCRYPTION_KEYS: invalid key id "${id}"`);
    if (seen.has(id)) throw new KeyProviderError(`ENCRYPTION_KEYS: duplicate key id "${id}"`);
    seen.add(id);
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) {
      throw new KeyProviderError(`ENCRYPTION_KEYS: key "${id}" must be 32 bytes, base64-encoded`);
    }
    return { id, key };
  });
}

/** AES-256-GCM wrap of a 32-byte data key under `key`, bound to `keyId` as AAD. */
export function wrapDek(key: Buffer, keyId: string, dek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(keyId, 'utf8'));
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

export function unwrapDek(key: Buffer, keyId: string, wrapped: Buffer): Buffer {
  if (wrapped.length !== NONCE_BYTES + 32 + TAG_BYTES) {
    throw new KeyProviderError('malformed wrapped data key');
  }
  const nonce = wrapped.subarray(0, NONCE_BYTES);
  const ct = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + 32);
  const tag = wrapped.subarray(NONCE_BYTES + 32);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(keyId, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new KeyProviderError('data key unwrap failed (wrong key or tampered)');
  }
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();
  readonly currentKeyId: string;

  constructor(keys: MasterKey[]) {
    const first = keys[0];
    if (!first) throw new KeyProviderError('at least one master key is required');
    for (const k of keys) this.keys.set(k.id, k.key);
    this.currentKeyId = first.id;
  }

  static fromEnv(raw: string): EnvKeyProvider {
    return new EnvKeyProvider(parseEncryptionKeys(raw));
  }

  wrap(dek: Buffer): { keyId: string; wrapped: Buffer } {
    const keyId = this.currentKeyId;
    const master = this.keys.get(keyId)!;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', master, nonce);
    cipher.setAAD(Buffer.from(keyId, 'utf8'));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { keyId, wrapped: Buffer.concat([nonce, ct, cipher.getAuthTag()]) };
  }

  unwrap(keyId: string, wrapped: Buffer): Buffer {
    const master = this.keys.get(keyId);
    if (!master) throw new KeyProviderError(`unknown encryption key id "${keyId}"`);
    if (wrapped.length !== NONCE_BYTES + 32 + TAG_BYTES) {
      throw new KeyProviderError('malformed wrapped data key');
    }
    const nonce = wrapped.subarray(0, NONCE_BYTES);
    const ct = wrapped.subarray(NONCE_BYTES, NONCE_BYTES + 32);
    const tag = wrapped.subarray(NONCE_BYTES + 32);
    const decipher = createDecipheriv('aes-256-gcm', master, nonce);
    decipher.setAAD(Buffer.from(keyId, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new KeyProviderError('data key unwrap failed (wrong key or tampered)');
    }
  }
}
