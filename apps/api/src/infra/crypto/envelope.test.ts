import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envelopeKeyId, open, seal } from './envelope.js';
import { EnvKeyProvider, KeyProviderError, parseEncryptionKeys } from './key-provider.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('parseEncryptionKeys', () => {
  it('parses ordered keys and rejects malformed input', () => {
    const keys = parseEncryptionKeys(`k2:${k2}, k1:${k1}`);
    expect(keys.map((k) => k.id)).toEqual(['k2', 'k1']);
    expect(() => parseEncryptionKeys('')).toThrow(KeyProviderError);
    expect(() => parseEncryptionKeys('nocolon')).toThrow(KeyProviderError);
    expect(() => parseEncryptionKeys('k1:short')).toThrow(/32 bytes/);
    expect(() => parseEncryptionKeys(`k1:${k1},k1:${k2}`)).toThrow(/duplicate/);
    expect(() => parseEncryptionKeys(`bad id!:${k1}`)).toThrow(/invalid key id/);
  });
});

describe('envelope encryption', () => {
  const kp = EnvKeyProvider.fromEnv(`k1:${k1}`);
  const aad = 'social_account.access_token:0193b6b0-0000-7000-8000-000000000001';

  it('round-trips and produces distinct ciphertexts', () => {
    const a = seal(kp, 'AQV-secret-token', aad);
    const b = seal(kp, 'AQV-secret-token', aad);
    expect(a.equals(b)).toBe(false);
    expect(open(kp, a, aad)).toBe('AQV-secret-token');
    expect(open(kp, b, aad)).toBe('AQV-secret-token');
    expect(a.toString('latin1')).not.toContain('AQV-secret');
    expect(envelopeKeyId(a)).toBe('k1');
  });

  it('handles unicode and empty strings', () => {
    expect(open(kp, seal(kp, '', aad), aad)).toBe('');
    expect(open(kp, seal(kp, 'ntn_ключ_🔑', aad), aad)).toBe('ntn_ключ_🔑');
  });

  it('fails on a different aad (row/column swap)', () => {
    const blob = seal(kp, 'secret', aad);
    expect(() => open(kp, blob, 'social_account.access_token:other-row')).toThrow(
      /decryption failed/,
    );
  });

  it('detects tampering of ciphertext, tag and wrapped key', () => {
    const blob = seal(kp, 'secret', aad);
    for (const idx of [blob.length - 1, blob.length - 20, 5]) {
      const t = Buffer.from(blob);
      t[idx] = t[idx]! ^ 0xff;
      expect(() => open(kp, t, aad)).toThrow();
    }
  });

  it('supports key rotation: old envelopes open with the old key, new ones use the new key', () => {
    const before = seal(kp, 'secret', aad);
    const rotated = EnvKeyProvider.fromEnv(`k2:${k2},k1:${k1}`);
    expect(open(rotated, before, aad)).toBe('secret');
    const after = seal(rotated, 'secret', aad);
    expect(envelopeKeyId(after)).toBe('k2');
    expect(() => open(kp, after, aad)).toThrow(/unknown encryption key id/);
  });
});
