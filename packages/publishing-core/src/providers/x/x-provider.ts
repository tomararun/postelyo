import type {
  CommentInput,
  CommentResult,
  MetricsInput,
  MetricsResult,
  LoadedMedia,
  PostSnapshot,
  ProviderCapabilities,
  ProviderContext,
  ProviderPostRef,
  PublishInput,
  PublishResult,
  PublishingProvider,
  RenderedContent,
  RenderedMedia,
  SocialAccountRef,
  ValidationResult,
} from '../../provider.js';
import {
  contentForProvider,
  contentToPlainText,
  textFingerprint,
  validateAgainstCapabilities,
} from '../../render.js';
import { asRecord, classifyNetworkError, parseJson, rawOf, str } from '../shared/graph-errors.js';

/**
 * X (Twitter) adapter: API v2 with OAuth 2.0 user context (Phase 2). Text plus
 * one image; the image is uploaded first (idempotent), then the tweet is
 * created (the only ambiguous call). Verify endpoints, the media upload
 * payload and the paid-tier requirements before the first live publish.
 */

export const X_TWEETS_URL = 'https://api.x.com/2/tweets';
export const X_MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
export const X_USERS_URL = 'https://api.x.com/2/users';
export const X_MAX_WEIGHTED_LENGTH = 280;
export const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** URLs are wrapped by t.co and always count as this many characters. */
const URL_WEIGHT = 23;
const URL_RE = /https?:\/\/[^\s]+/g;

export interface XProviderOptions {
  fetchImpl?: typeof fetch;
}

/** X counts URLs as 23 characters and most other characters as 1 (CJK as 2; ignored here). */
export function weightedLength(text: string): number {
  let n = 0;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    n += [...text.slice(last, m.index)].length + URL_WEIGHT;
    last = m.index + m[0].length;
  }
  return n + [...text.slice(last)].length;
}

export class XProvider implements PublishingProvider {
  readonly id = 'x' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: XProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  capabilities(): ProviderCapabilities {
    return {
      maxTextLength: X_MAX_WEIGHTED_LENGTH,
      maxImages: 1,
      supportedImageMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      maxImageBytes: X_MAX_IMAGE_BYTES,
      firstComment: true,
      metrics: true,
      image: { delivery: 'upload' },
    };
  }

  render(post: PostSnapshot, _account: SocialAccountRef): RenderedContent {
    const content = contentForProvider(post.content, this.id);
    const text = contentToPlainText(content);
    return {
      text,
      media: content.media.map((m) => ({
        assetId: m.assetId,
        mimeType: 'image/png',
        byteSize: 0,
        ...(m.alt !== undefined ? { alt: m.alt } : {}),
      })),
    };
  }

  validate(content: RenderedContent, _account: SocialAccountRef): ValidationResult {
    const issues = validateAgainstCapabilities(content, this.capabilities(), {
      providerName: 'X',
      length: weightedLength,
    });
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult> {
    const mediaIds: string[] = [];
    const image = input.content.media[0];
    if (image) {
      const step = await this.ensureMedia(image, input, ctx);
      if (!step.ok) return step.result;
      mediaIds.push(step.value);
    }

    const body = {
      text: input.content.text,
      ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(X_TWEETS_URL, {
        method: 'POST',
        headers: this.headers(ctx, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return classifyNetworkError(err, true, 'X');
    }
    const text = await res.text().catch(() => '');
    const raw = rawOf(res.status, text);
    if (res.status === 201 || res.status === 200) {
      const id = str(asRecord(parseJson(text)['data']), 'id');
      if (!id) return { kind: 'ambiguous', reason: 'X returned success without a tweet id', raw };
      return { kind: 'published', providerPostId: id, url: `https://x.com/i/status/${id}`, raw };
    }
    return classifyHttp(res, text, raw, true);
  }

  async lookupRecent(
    account: SocialAccountRef,
    since: Date,
    ctx: ProviderContext,
  ): Promise<ProviderPostRef[]> {
    const u = new URL(`${X_USERS_URL}/${encodeURIComponent(account.providerAccountId)}/tweets`);
    u.searchParams.set('max_results', '10');
    u.searchParams.set('tweet.fields', 'created_at');
    u.searchParams.set('start_time', since.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const res = await this.fetchImpl(u.toString(), {
      method: 'GET',
      headers: this.headers(ctx, { accept: 'application/json' }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`X tweet lookup failed (${res.status}): ${messageOf(text)}`);
    const data = parseJson(text)['data'];
    const out: ProviderPostRef[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const t = asRecord(raw);
      const id = str(t, 'id');
      if (!id) continue;
      const created = str(t, 'created_at');
      out.push({
        providerPostId: id,
        url: `https://x.com/i/status/${id}`,
        ...(created ? { publishedAt: new Date(created) } : {}),
        textHash: textFingerprint(str(t, 'text') ?? ''),
      });
    }
    return out;
  }

  /** Reuses a cached media id or uploads the bytes (multipart, tweet_image category). */
  private async ensureMedia(
    media: RenderedMedia,
    input: PublishInput,
    ctx: ProviderContext,
  ): Promise<{ ok: true; value: string } | { ok: false; result: PublishResult }> {
    if (media.providerRef) return { ok: true, value: media.providerRef };
    if (!input.loadMedia) {
      return {
        ok: false,
        result: { kind: 'terminal_error', code: 'other', reason: 'media loader not provided' },
      };
    }
    let loaded: LoadedMedia;
    try {
      loaded = await input.loadMedia(media.assetId);
    } catch (err) {
      return { ok: false, result: mediaLoadFailure(err) };
    }
    const form = new FormData();
    form.set('media_category', 'tweet_image');
    form.set(
      'media',
      new Blob([loaded.bytes], { type: loaded.mimeType }),
      loaded.fileName ?? `image.${loaded.mimeType.split('/')[1] ?? 'bin'}`,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(X_MEDIA_UPLOAD_URL, {
        method: 'POST',
        headers: this.headers(ctx, {}),
        body: form,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { ok: false, result: classifyNetworkError(err, false, 'X') };
    }
    const text = await res.text().catch(() => '');
    if (!res.ok)
      return { ok: false, result: classifyHttp(res, text, rawOf(res.status, text), false) };
    const json = parseJson(text);
    const id = str(asRecord(json['data']), 'id') ?? str(json, 'media_id_string');
    if (!id) {
      return {
        ok: false,
        result: { kind: 'retryable_error', reason: 'X media upload response had no media id' },
      };
    }
    await input.onMediaUploaded?.(media.assetId, id, loaded.contentHash);
    return { ok: true, value: id };
  }

  /**
   * Phase 5 metrics: `GET /2/tweets/:id` with public and non-public metrics.
   * Non-public metrics (link clicks) need the user context of the tweet's
   * owner, which is how Postelyo publishes, and are only kept for 30 days.
   */
  async metrics(input: MetricsInput, ctx: ProviderContext): Promise<MetricsResult> {
    const u = new URL(`${X_TWEETS_URL}/${encodeURIComponent(input.providerPostId)}`);
    u.searchParams.set('tweet.fields', 'public_metrics,non_public_metrics');
    let res: Response;
    try {
      res = await this.fetchImpl(u.toString(), {
        method: 'GET',
        headers: this.headers(ctx, { accept: 'application/json' }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: `X unreachable: ${(err as Error).message}`,
        retryable: true,
      };
    }
    const text = await res.text().catch(() => '');
    const raw = rawOf(res.status, text);
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      return {
        kind: 'unavailable',
        reason: `X metrics failed (${res.status}): ${messageOf(text)}`,
        retryable: res.status === 429 || res.status >= 500,
        ...(res.status === 429
          ? { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 15 * 60_000 }
          : {}),
        raw,
      };
    }
    const data = asRecord(parseJson(text)['data']);
    if (Object.keys(data).length === 0) {
      return {
        kind: 'unavailable',
        reason: 'X did not return the tweet (deleted?)',
        retryable: false,
        raw,
      };
    }
    const pub = asRecord(data['public_metrics']);
    const priv = asRecord(data['non_public_metrics']);
    const n = (o: Record<string, unknown>, k: string) => (typeof o[k] === 'number' ? o[k] : null);
    const retweets = n(pub, 'retweet_count');
    const quotes = n(pub, 'quote_count');
    return {
      kind: 'metrics',
      metrics: {
        impressions: n(pub, 'impression_count') ?? n(priv, 'impression_count'),
        reach: null,
        reactions: n(pub, 'like_count'),
        comments: n(pub, 'reply_count'),
        shares: retweets === null && quotes === null ? null : (retweets ?? 0) + (quotes ?? 0),
        clicks: n(priv, 'url_link_clicks'),
        saves: n(pub, 'bookmark_count'),
      },
      raw,
    };
  }

  /** First comment on X is a reply to the published tweet. */
  async comment(input: CommentInput, ctx: ProviderContext): Promise<CommentResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(X_TWEETS_URL, {
        method: 'POST',
        headers: this.headers(ctx, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          text: input.text,
          reply: { in_reply_to_tweet_id: input.providerPostId },
        }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return {
        kind: 'failed',
        reason: `X unreachable: ${(err as Error).message}`,
        retryable: true,
      };
    }
    const text = await res.text().catch(() => '');
    const raw = rawOf(res.status, text);
    if (res.status === 201 || res.status === 200) {
      const id = str(asRecord(parseJson(text)['data']), 'id');
      return id
        ? { kind: 'posted', commentId: id, raw }
        : {
            kind: 'failed',
            reason: 'X returned success without a reply id',
            retryable: false,
            raw,
          };
    }
    return {
      kind: 'failed',
      reason: `X rejected the reply: ${messageOf(text)}`,
      retryable: res.status === 429 || res.status >= 500,
      raw,
    };
  }

  private headers(ctx: ProviderContext, extra: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${ctx.credentials.accessToken}`, ...extra };
  }
}

function messageOf(text: string): string {
  const j = parseJson(text);
  const errors = j['errors'];
  const first = Array.isArray(errors) ? asRecord(errors[0]) : {};
  return str(first, 'message') ?? str(j, 'detail') ?? str(j, 'title') ?? 'unknown error';
}

function classifyHttp(
  res: Response,
  text: string,
  raw: unknown,
  tweetCall: boolean,
): PublishResult {
  const message = messageOf(text);
  switch (res.status) {
    case 401:
      return {
        kind: 'terminal_error',
        code: 'auth',
        reason: `X rejected the access token: ${message}`,
        raw,
      };
    case 403:
      return /duplicate/i.test(message)
        ? {
            kind: 'terminal_error',
            code: 'content',
            reason: `X rejected the post: ${message}`,
            raw,
          }
        : {
            kind: 'terminal_error',
            code: 'permission',
            reason: `X denied permission: ${message}`,
            raw,
          };
    case 400:
    case 422:
      return {
        kind: 'terminal_error',
        code: 'content',
        reason: `X rejected the post: ${message}`,
        raw,
      };
    case 429: {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      const waitMs =
        Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 0;
      return {
        kind: 'retryable_error',
        code: 'rate_limit',
        reason: `X rate limit reached: ${message}`,
        retryAfterMs: waitMs > 0 ? waitMs : 15 * 60_000,
        raw,
      };
    }
    case 502:
    case 503:
    case 504:
      return { kind: 'retryable_error', reason: `X unavailable (${res.status})`, raw };
    default:
      return tweetCall
        ? { kind: 'ambiguous', reason: `Unexpected X response ${res.status}: ${message}`, raw }
        : {
            kind: 'retryable_error',
            reason: `Unexpected X response ${res.status}: ${message}`,
            raw,
          };
  }
}

export function mediaLoadFailure(err: unknown): PublishResult {
  const e = err as { code?: string; message?: string };
  const terminal =
    e.code === 'not_found' ||
    e.code === 'not_an_image' ||
    e.code === 'unsupported_type' ||
    e.code === 'too_large' ||
    e.code === 'blocked_url' ||
    e.code === 'invalid_url';
  return terminal
    ? {
        kind: 'terminal_error',
        code: 'content',
        reason: `Image cannot be used: ${e.message ?? 'unknown error'}`,
      }
    : { kind: 'retryable_error', reason: `Image download failed: ${e.message ?? 'unknown error'}` };
}
