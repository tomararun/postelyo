import type {
  CommentInput,
  CommentResult,
  ProviderContext,
  PublishResult,
} from '../../provider.js';
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

/** Phase 4 first comment for Facebook Pages and Instagram: `POST /{object-id}/comments`. */
export async function graphComment(
  fetchImpl: typeof fetch,
  graphUrl: string,
  input: CommentInput,
  ctx: ProviderContext,
  provider: string,
): Promise<CommentResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${graphUrl}/${encodeURIComponent(input.providerPostId)}/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.credentials.accessToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form({ message: input.text }).toString(),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (err) {
    return {
      kind: 'failed',
      reason: `${provider} unreachable: ${(err as Error).message}`,
      retryable: true,
    };
  }
  const text = await res.text().catch(() => '');
  const raw = { status: res.status, body: text.slice(0, 2000) };
  if (res.ok) {
    const id = str(parseJson(text), 'id');
    return id
      ? { kind: 'posted', commentId: id, raw }
      : {
          kind: 'failed',
          reason: `${provider} returned success without a comment id`,
          retryable: false,
          raw,
        };
  }
  const err = graphError(text);
  const code = err?.code ?? 0;
  const retryable =
    res.status === 429 ||
    res.status >= 500 ||
    code === 1 ||
    code === 2 ||
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 613;
  return {
    kind: 'failed',
    reason: `${provider} rejected the comment: ${err?.message ?? res.statusText}`,
    retryable,
    raw,
  };
}

export function form(fields: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p;
}
