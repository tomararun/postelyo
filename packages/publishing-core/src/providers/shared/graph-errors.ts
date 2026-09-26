import type { PublishResult } from '../../provider.js';

/**
 * Shared HTTP/network classification for adapters that speak JSON to a REST
 * API. Each adapter still decides which call is the non-idempotent one.
 */

export function classifyNetworkError(err: unknown, sent: boolean, provider: string): PublishResult {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || !sent) {
    return {
      kind: 'retryable_error',
      reason: `${provider} unreachable (${code || e.name || 'network error'})`,
    };
  }
  // Timeouts, aborts and resets on the non-idempotent call: it may have been processed.
  const label = e.name ?? (code.length > 0 ? code : 'network error');
  return { kind: 'ambiguous', reason: `No response from ${provider} (${label})` };
}

export function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Truncated response summary for `publish_attempt.response_meta`. */
export function rawOf(status: number, text: string): { status: number; body: string } {
  return { status, body: text.slice(0, 2000) };
}
