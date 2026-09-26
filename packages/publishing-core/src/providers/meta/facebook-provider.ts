import type {
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
import { GRAPH_URL, classifyGraph, form } from './graph.js';

/**
 * Facebook Pages adapter (Phase 2): posts to a Page's feed with the Page
 * access token. Images are delivered by public URL (`/photos` with `url`),
 * so the engine hands over a stored variant. Needs `pages_manage_posts` and
 * app review; verify fields against the current Graph API docs.
 */

export const FACEBOOK_MAX_TEXT = 63_206;
export const FACEBOOK_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface FacebookProviderOptions {
  fetchImpl?: typeof fetch;
  graphUrl?: string;
}

export class FacebookProvider implements PublishingProvider {
  readonly id = 'facebook' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly graphUrl: string;

  constructor(opts: FacebookProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.graphUrl = opts.graphUrl ?? GRAPH_URL;
  }

  capabilities(): ProviderCapabilities {
    return {
      maxTextLength: FACEBOOK_MAX_TEXT,
      maxImages: 1,
      supportedImageMimeTypes: ['image/jpeg', 'image/png'],
      maxImageBytes: FACEBOOK_MAX_IMAGE_BYTES,
      image: { delivery: 'url', outputMimeType: 'image/jpeg', maxWidth: 2048 },
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
      providerName: 'Facebook',
    });
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult> {
    const pageId = encodeURIComponent(input.account.providerAccountId);
    const image = input.content.media[0];
    let url: string;
    let fields: Record<string, string | undefined>;
    if (image) {
      if (!input.mediaUrl) {
        return { kind: 'terminal_error', code: 'other', reason: 'media url resolver not provided' };
      }
      let imageUrl: string;
      try {
        imageUrl = (await input.mediaUrl(image.assetId, this.capabilities().image!)).url;
      } catch (err) {
        return mediaUrlFailure(err);
      }
      url = `${this.graphUrl}/${pageId}/photos`;
      fields = { url: imageUrl, message: input.content.text, published: 'true' };
    } else {
      url = `${this.graphUrl}/${pageId}/feed`;
      fields = { message: input.content.text };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ctx.credentials.accessToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form(fields).toString(),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return classifyNetworkError(err, true, 'Facebook');
    }
    const text = await res.text().catch(() => '');
    const raw = rawOf(res.status, text);
    if (res.ok) {
      const json = parseJson(text);
      const postId = str(json, 'post_id') ?? str(json, 'id');
      if (!postId) {
        return { kind: 'ambiguous', reason: 'Facebook returned success without a post id', raw };
      }
      return {
        kind: 'published',
        providerPostId: postId,
        url: `https://www.facebook.com/${postId}`,
        raw,
      };
    }
    return classifyGraph(res, text, raw, 'Facebook', true);
  }

  async lookupRecent(
    account: SocialAccountRef,
    since: Date,
    ctx: ProviderContext,
  ): Promise<ProviderPostRef[]> {
    const u = new URL(`${this.graphUrl}/${encodeURIComponent(account.providerAccountId)}/feed`);
    u.searchParams.set('fields', 'id,message,created_time,permalink_url');
    u.searchParams.set('limit', '20');
    u.searchParams.set('since', String(Math.floor(since.getTime() / 1000)));
    const res = await this.fetchImpl(u.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Facebook feed lookup failed (${res.status})`);
    const data = parseJson(text)['data'];
    const out: ProviderPostRef[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const p = asRecord(raw);
      const id = str(p, 'id');
      if (!id) continue;
      const created = str(p, 'created_time');
      out.push({
        providerPostId: id,
        url: str(p, 'permalink_url') ?? `https://www.facebook.com/${id}`,
        ...(created ? { publishedAt: new Date(created) } : {}),
        textHash: textFingerprint(str(p, 'message') ?? ''),
      });
    }
    return out;
  }
}

export function mediaUrlFailure(err: unknown): PublishResult {
  const e = err as { code?: string; message?: string };
  const terminal =
    e.code === 'not_found' ||
    e.code === 'not_an_image' ||
    e.code === 'unsupported_type' ||
    e.code === 'too_large' ||
    e.code === 'blocked_url' ||
    e.code === 'invalid_url' ||
    e.code === 'unprocessable';
  return terminal
    ? {
        kind: 'terminal_error',
        code: 'content',
        reason: `Image cannot be used: ${e.message ?? 'unknown error'}`,
      }
    : {
        kind: 'retryable_error',
        reason: `Image could not be prepared: ${e.message ?? 'unknown error'}`,
      };
}
