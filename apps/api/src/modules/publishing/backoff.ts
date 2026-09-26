/**
 * Retry policy (architecture §10.2): exponential backoff with full jitter,
 * base 30 s, factor 2, cap 15 min. A provider `Retry-After` overrides the delay.
 */

export const RETRY_BASE_MS = 30_000;
export const RETRY_FACTOR = 2;
export const RETRY_CAP_MS = 15 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface BackoffInput {
  /** 1-based number of the attempt that just failed. */
  attemptNo: number;
  retryAfterMs?: number | undefined;
  /** Uniform random in [0, 1); injectable for deterministic tests. */
  random?: () => number;
}

export function backoffMs(input: BackoffInput): number {
  if (input.retryAfterMs !== undefined && input.retryAfterMs > 0) {
    return Math.min(input.retryAfterMs, RETRY_CAP_MS);
  }
  const random = input.random ?? Math.random;
  const exp = Math.min(
    RETRY_CAP_MS,
    RETRY_BASE_MS * RETRY_FACTOR ** Math.max(0, input.attemptNo - 1),
  );
  // Full jitter: uniform in [base/2, exp] so retries never collapse to zero delay.
  const floor = Math.min(RETRY_BASE_MS / 2, exp);
  return Math.round(floor + random() * (exp - floor));
}
