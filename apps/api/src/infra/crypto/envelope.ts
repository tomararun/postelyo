import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

/**
 * Envelope encryption of a single secret value (security.md §6.2).
 *
 * blob = version(1) | keyIdLen(1) | keyId | wrappedDek(60) | nonce(12) | tag(16) | ciphertext
 *
 * `aad` binds the ciphertext to its row and column (e.g. "social_account.access_token:<id>")
 * so values cannot be swapped between rows without detection.
 */

const VERSION = 1;
const WRAPPED_DEK_BYTES = 12 + 32 + 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export function seal(kp: KeyProvider, plaintext: string, aad: string): Buffer {
  const dek = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const { keyId, wrapped } = kp.wrap(dek);
  dek.fill(0);
  const keyIdBuf = Buffer.from(keyId, 'utf8');
  if (keyIdBuf.length > 255) throw new EnvelopeError('key id too long');
  return Buffer.concat([
    Buffer.from([VERSION, keyIdBuf.length]),
    keyIdBuf,
    wrapped,
    nonce,
    tag,
    ct,
  ]);
}

export function open(kp: KeyProvider, blob: Buffer, aad: string): string {
  if (blob.length < 2) throw new EnvelopeError('blob too short');
  if (blob[0] !== VERSION) throw new EnvelopeError(`unsupported envelope version ${blob[0]}`);
  const keyIdLen = blob[1]!;
  let off = 2;
  const keyId = blob.subarray(off, off + keyIdLen).toString('utf8');
  off += keyIdLen;
  const wrapped = blob.subarray(off, off + WRAPPED_DEK_BYTES);
  off += WRAPPED_DEK_BYTES;
  const nonce = blob.subarray(off, off + NONCE_BYTES);
  off += NONCE_BYTES;
  const tag = blob.subarray(off, off + TAG_BYTES);
  off += TAG_BYTES;
  const ct = blob.subarray(off);
  if (
    wrapped.length !== WRAPPED_DEK_BYTES ||
    nonce.length !== NONCE_BYTES ||
    tag.length !== TAG_BYTES
  ) {
    throw new EnvelopeError('malformed envelope');
  }
  const dek = kp.unwrap(keyId, Buffer.from(wrapped));
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new EnvelopeError('decryption failed (wrong aad, key, or tampered data)');
  } finally {
    dek.fill(0);
  }
}

/** Key id recorded in an envelope, for rotation bookkeeping. */
export function envelopeKeyId(blob: Buffer): string {
  if (blob.length < 2 || blob[0] !== VERSION) throw new EnvelopeError('malformed envelope');
  return blob.subarray(2, 2 + blob[1]!).toString('utf8');
}
