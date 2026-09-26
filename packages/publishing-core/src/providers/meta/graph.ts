import type {
  CommentInput,
  CommentResult,
  MetricsResult,
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

/** Phase 5: a Graph GET whose failure maps to a metrics `unavailable` result. */
export async function graphGet(
  fetchImpl: typeof fetch,
  url: URL,
  ctx: ProviderContext,
  provider: string,
): Promise<
  { ok: true; json: Record<string, unknown>; raw: unknown } | { ok: false; result: MetricsResult }
> {
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      result: {
        kind: 'unavailable',
        reason: `${provider} unreachable: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }
  const text = await res.text().catch(() => '');
  const raw = { status: res.status, body: text.slice(0, 2000) };
  if (!res.ok) {
    const err = graphError(text);
    const code = err?.code ?? 0;
    const rateLimited =
      res.status === 429 || code === 4 || code === 17 || code === 32 || code === 613;
    const retryable = rateLimited || res.status >= 500 || code === 1 || code === 2;
    return {
      ok: false,
      result: {
        kind: 'unavailable',
        reason: `${provider} metrics failed: ${err?.message ?? res.statusText}`,
        retryable,
        ...(rateLimited ? { retryAfterMs: 60 * 60_000 } : {}),
        raw,
      },
    };
  }
  return { ok: true, json: parseJson(text), raw };
}

/** `/insights` responses: `data[].name` → the latest value (`values[0].value` or `total_value.value`). */
export function insightValues(json: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of Array.isArray(json['data']) ? json['data'] : []) {
    const item = asRecord(raw);
    const name = str(item, 'name');
    if (!name) continue;
    const values = Array.isArray(item['values']) ? item['values'] : [];
    const first = asRecord(values[0]);
    const total = asRecord(item['total_value']);
    const v = first['value'] ?? total['value'];
    if (typeof v === 'number') out[name] = v;
    else if (typeof v === 'object' && v !== null) {
      // e.g. post_reactions_by_type_total: { like: 3, love: 1 }
      out[name] = Object.values(v as Record<string, unknown>).reduce<number>(
        (sum, x) => sum + (typeof x === 'number' ? x : 0),
        0,
      );
    }
  }
  return out;
}

export function form(fields: Record<string, string | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p;
}
