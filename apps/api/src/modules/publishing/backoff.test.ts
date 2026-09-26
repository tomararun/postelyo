import { describe, expect, it } from 'vitest';
import { RETRY_CAP_MS, backoffMs } from './backoff.js';

describe('backoffMs', () => {
  it('grows exponentially with jitter and caps at 15 minutes', () => {
    const max = () => 0.999999;
    expect(backoffMs({ attemptNo: 1, random: max })).toBeLessThanOrEqual(30_000);
    expect(backoffMs({ attemptNo: 2, random: max })).toBeLessThanOrEqual(60_000);
    expect(backoffMs({ attemptNo: 3, random: max })).toBeLessThanOrEqual(120_000);
    expect(backoffMs({ attemptNo: 10, random: max })).toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(backoffMs({ attemptNo: 10, random: () => 0 })).toBe(15_000);
  });

  it('never returns less than half the base delay', () => {
    for (let a = 1; a <= 6; a++) expect(backoffMs({ attemptNo: a, random: () => 0 })).toBe(15_000);
  });

  it('honours Retry-After but still caps it', () => {
    expect(backoffMs({ attemptNo: 1, retryAfterMs: 5_000 })).toBe(5_000);
    expect(backoffMs({ attemptNo: 1, retryAfterMs: 60 * 60_000 })).toBe(RETRY_CAP_MS);
    expect(backoffMs({ attemptNo: 1, retryAfterMs: 0, random: () => 0 })).toBe(15_000);
  });
});
