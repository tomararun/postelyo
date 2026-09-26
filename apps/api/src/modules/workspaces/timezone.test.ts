import { describe, expect, it } from 'vitest';
import { PUBLISH_TIME_RE, isValidTimeZone } from './timezone.js';

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Etc/UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('+02:00')).toBe(false);
  });
});

describe('PUBLISH_TIME_RE', () => {
  it('matches 24h wall-clock times', () => {
    expect(PUBLISH_TIME_RE.test('09:00')).toBe(true);
    expect(PUBLISH_TIME_RE.test('23:59:59')).toBe(true);
    expect(PUBLISH_TIME_RE.test('24:00')).toBe(false);
    expect(PUBLISH_TIME_RE.test('9:00')).toBe(false);
  });
});
