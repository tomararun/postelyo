import type { PublishResult } from '../../provider.js';
import { asRecord, num, parseJson, str } from '../shared/graph-errors.js';

/**
 * Shared Meta Graph API plumbing for the Facebook Pages and Instagram
 * adapters. Version is pinned and bumped deliberately with a contract run.
 */

export const GRAPH_VERSION = 'v21.0';
export const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface GraphError {
  code: number;
  subcode: number | undefined;
  type: string;
  message: string;
}

export function graphError(text: string): GraphError | null {
  const e = asRecord(parseJson(text)['error']);
  if (Object.keys(e).length === 0) return null;
  return {
    code: num(e, 'code') ?? 0,
    subcode: num(e, 'error_subcode'),
    type: str(e, 'type') ?? 'OAuthException',
    message: str(e, 'message') ?? 'unknown error',
  };
}

/**
 * Graph error codes (verify against Meta's docs): 190 invalid/expired token;
 * 4, 17, 32, 613 throttling; 10, 200–299, 803 permissions; 100 invalid
 * parameter; 1, 2 temporary.
 */
export function classifyGraph(
  res: Response,
  text: string,
  raw: unknown,
  provider: string,
  nonIdempotentCall: boolean,
): PublishResult {
  const err = graphError(text);
  const message = err?.message ?? (res.statusText || `HTTP ${res.status}`);
  const code = err?.code ?? 0;
  if (code === 190 || res.status === 401) {
    return {
      kind: 'terminal_error',
      code: 'auth',
      reason: `${provider} rejected the access token: ${message}`,
      raw,
    };
  }
  if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) {
    return {
      kind: 'retryable_error',
      code: 'rate_limit',
      reason: `${provider} rate limit reached: ${message}`,
      retryAfterMs: 60 * 60_000,
      raw,
    };
  }
  if (code === 10 || (code >= 200 && code <= 299) || code === 803 || res.status === 403) {
    return {
      kind: 'terminal_error',
      code: 'permission',
      reason: `${provider} denied permission: ${message}`,
      raw,
    };
  }
  if (code === 100 || code === 368 || res.status === 400) {
    return {
      kind: 'terminal_error',
      code: 'content',
      reason: `${provider} rejected the post: ${message}`,
      raw,
    };
  }
  if (code === 1 || code === 2 || res.status === 502 || res.status === 503 || res.status === 504) {
    return {
      kind: 'retryable_error',
      reason: `${provider} temporarily unavailable: ${message}`,
      raw,
    };
  }
  return nonIdempotentCall
    ? {
        kind: 'ambiguous',
        reason: `Unexpected ${provider} response ${res.status}: ${message}`,
        raw,
      }
    : {
        kind: 'retryable_error',
        reason: `Unexpected ${provider} response ${res.status}: ${message}`,
        raw,
      };
}

export function form(fields: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p;
}
