import type {
  CommentInput,
  CommentResult,
  MetricsInput,
  MetricsResult,
  PostSnapshot,
  ProviderCapabilities,
  ProviderContext,
  ProviderPostRef,
  PublishInput,
  PublishResult,
  PublishingProvider,
  RenderedContent,
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
import { mediaUrlFailure } from './facebook-provider.js';
import { GRAPH_URL, classifyGraph, form, graphComment, graphGet, insightValues } from './graph.js';

/**
 * Instagram adapter (Phase 2) for professional accounts linked to a Facebook
 * Page, using the Content Publishing API: create a media container from a
 * public image URL, wait until it is ready, then publish it. Only the final
 * `media_publish` call is non-idempotent. Needs `instagram_content_publish`
 * and app review; verify against the current Graph API docs.
 */

export const INSTAGRAM_MAX_CAPTION = 2200;
export const INSTAGRAM_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Container status polling: attempts × delay must stay well under the publish timeout. */
const CONTAINER_POLLS = 6;
const CONTAINER_POLL_MS = 2000;

export interface InstagramProviderOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
  pollDelayMs?: number;
}

export class InstagramProvider implements PublishingProvider {
  readonly id = 'instagram' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;
  private readonly pollDelayMs: number;

  constructor(opts: InstagramProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphUrl = opts.graphUrl ?? GRAPH_URL;
    this.pollDelayMs = opts.pollDelayMs ?? CONTAINER_POLL_MS;
  }

  capabilities(): ProviderCapabilities {
    return {
      maxTextLength: INSTAGRAM_MAX_CAPTION,
      maxImages: 1,
      supportedImageMimeTypes: ['image/jpeg', 'image/png'],
      maxImageBytes: INSTAGRAM_MAX_IMAGE_BYTES,
      firstComment: true,
      metrics: true,
      imageRequired: true,
      image: {
        delivery: 'url',
        outputMimeType: 'image/jpeg',
        minWidth: 320,
        maxWidth: 1440,
        minAspect: 0.8,
        maxAspect: 1.91,
      },
    };
  }

  render(post: PostSnapshot, _account: SocialAccountRef): RenderedContent {
    const content = contentForProvider(post.content, this.id);
    return {
      text: contentToPlainText(content),
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
      providerName: 'Instagram',
    });
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult> {
    const igId = encodeURIComponent(input.account.providerAccountId);
    const image = input.content.media[0];
    if (!image) {
      return { kind: 'terminal_error', code: 'content', reason: 'Instagram posts need an image.' };
    }
    if (!input.mediaUrl) {
      return { kind: 'terminal_error', code: 'other', reason: 'media url resolver not provided' };
    }
    let imageUrl: string;
    try {
      imageUrl = (await input.mediaUrl(image.assetId, this.capabilities().image!)).url;
    } catch (err) {
      return mediaUrlFailure(err);
    }
    const headers = {
      authorization: `Bearer ${ctx.credentials.accessToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    };

    // 1. Container (safe to repeat: unpublished containers expire on their own).
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${igId}/media`, {
        method: 'POST',
        headers,
        body: form({ image_url: imageUrl, caption: input.content.text }).toString(),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return classifyNetworkError(err, false, 'Instagram');
    }
    let text = await res.text().catch(() => '');
    if (!res.ok) return classifyGraph(res, text, rawOf(res.status, text), 'Instagram', false);
    const creationId = str(parseJson(text), 'id');
    if (!creationId) {
      return { kind: 'retryable_error', reason: 'Instagram container response had no id' };
    }

    // 2. Wait for processing.
    for (let i = 0; i < CONTAINER_POLLS; i++) {
      const status = await this.containerStatus(creationId, ctx);
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') {
        return {
          kind: 'terminal_error',
          code: 'content',
          reason: `Instagram could not process the image (container ${status}).`,
        };
      }
      if (i === CONTAINER_POLLS - 1) {
        return {
          kind: 'retryable_error',
          reason: 'Instagram is still processing the image; will retry.',
          retryAfterMs: 60_000,
        };
      }
      await new Promise((r) => setTimeout(r, this.pollDelayMs));
    }

    // 3. Publish (the ambiguous call).
    try {
      res = await this.fetchImpl(`${this.graphUrl}/${igId}/media_publish`, {
        method: 'POST',
        headers,
        body: form({ creation_id: creationId }).toString(),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return classifyNetworkError(err, true, 'Instagram');
    }
    text = await res.text().catch(() => '');
    const raw = rawOf(res.status, text);
    if (!res.ok) return classifyGraph(res, text, raw, 'Instagram', true);
    const mediaId = str(parseJson(text), 'id');
    if (!mediaId) {
      return { kind: 'ambiguous', reason: 'Instagram returned success without a media id', raw };
    }
    const permalink = await this.permalink(mediaId, ctx);
    return {
      kind: 'published',
      providerPostId: mediaId,
      ...(permalink ? { url: permalink } : {}),
      raw,
    };
  }

  /**
   * Phase 5 metrics: `/{ig-media-id}/insights`. Newer Graph versions replace
   * `impressions` with `views`; both are requested and the first present wins.
   */
  async metrics(input: MetricsInput, ctx: ProviderContext): Promise<MetricsResult> {
    const id = encodeURIComponent(input.providerPostId);
    const url = new URL(`${this.graphUrl}/${id}/insights`);
    url.searchParams.set('metric', 'views,reach,likes,comments,shares,saved');
    let res = await graphGet(this.fetchImpl, url, ctx, 'Instagram');
    if (!res.ok && res.result.kind === 'unavailable' && !res.result.retryable) {
      // Older media / API versions: retry with the legacy impressions metric.
      const legacy = new URL(`${this.graphUrl}/${id}/insights`);
      legacy.searchParams.set('metric', 'impressions,reach,likes,comments,shares,saved');
      res = await graphGet(this.fetchImpl, legacy, ctx, 'Instagram');
    }
    if (!res.ok) return res.result;
    const v = insightValues(res.json);
    return {
      kind: 'metrics',
      metrics: {
        impressions: v['views'] ?? v['impressions'] ?? null,
        reach: v['reach'] ?? null,
        reactions: v['likes'] ?? null,
        comments: v['comments'] ?? null,
        shares: v['shares'] ?? null,
        clicks: null,
        saves: v['saved'] ?? null,
      },
      raw: res.raw,
    };
  }

  /** First comment under the media (`/{ig-media-id}/comments`). */
  async comment(input: CommentInput, ctx: ProviderContext): Promise<CommentResult> {
    return graphComment(this.fetchImpl, this.graphUrl, input, ctx, 'Instagram');
  }

  async lookupRecent(
    account: SocialAccountRef,
    since: Date,
    ctx: ProviderContext,
  ): Promise<ProviderPostRef[]> {
    const u = new URL(`${this.graphUrl}/${encodeURIComponent(account.providerAccountId)}/media`);
    u.searchParams.set('fields', 'id,caption,timestamp,permalink');
    u.searchParams.set('limit', '20');
    const res = await this.fetchImpl(u.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Instagram media lookup failed (${res.status})`);
    const data = parseJson(text)['data'];
    const out: ProviderPostRef[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const m = asRecord(raw);
      const id = str(m, 'id');
      if (!id) continue;
      const ts = str(m, 'timestamp');
      const publishedAt = ts ? new Date(ts) : undefined;
      if (publishedAt && publishedAt.getTime() < since.getTime()) continue;
      out.push({
        providerPostId: id,
        ...(str(m, 'permalink') ? { url: str(m, 'permalink')! } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        textHash: textFingerprint(str(m, 'caption') ?? ''),
      });
    }
    return out;
  }

  private async containerStatus(creationId: string, ctx: ProviderContext): Promise<string> {
    const u = new URL(`${this.graphUrl}/${encodeURIComponent(creationId)}`);
    u.searchParams.set('fields', 'status_code');
    try {
      const res = await this.fetchImpl(u.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const text = await res.text().catch(() => '');
      return str(parseJson(text), 'status_code') ?? 'IN_PROGRESS';
    } catch {
      return 'IN_PROGRESS';
    }
  }

  private async permalink(mediaId: string, ctx: ProviderContext): Promise<string | null> {
    const u = new URL(`${this.graphUrl}/${encodeURIComponent(mediaId)}`);
    u.searchParams.set('fields', 'permalink');
    try {
      const res = await this.fetchImpl(u.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      });
      const text = await res.text().catch(() => '');
      return str(parseJson(text), 'permalink') ?? null;
    } catch {
      return null;
    }
  }
}
