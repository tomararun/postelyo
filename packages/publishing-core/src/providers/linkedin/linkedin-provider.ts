import type {
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
import { contentForProvider, textFingerprint } from '../../render.js';
import { renderLittleText, unescapeLittleText } from './little-text.js';

/**
 * LinkedIn publishing adapter for personal profiles and organization pages
 * (architecture §9.3, P1 + Phase 1). Pure I/O translator: no database, no
 * state. Every outcome maps to exactly one PublishResult kind so the engine
 * never inspects LinkedIn specifics.
 *
 * Endpoints, headers and error shapes must be verified against LinkedIn's docs
 * before the first live publish; they are isolated here. Organization posting
 * additionally needs Community Management API approval for the app.
 */

export const LINKEDIN_POSTS_URL = 'https://api.linkedin.com/rest/posts';
/** Default wait when LinkedIn throttles without a Retry-After header. */
export const LINKEDIN_RATE_LIMIT_WAIT_MS = 15 * 60_000;
export const LINKEDIN_IMAGES_INIT_URL =
  'https://api.linkedin.com/rest/images?action=initializeUpload';
/** Monthly LinkedIn-Version pin; bump deliberately with a contract-test run. */
export const LINKEDIN_API_VERSION = '202509';
export const LINKEDIN_MAX_TEXT = 3000;
export const LINKEDIN_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface LinkedInProviderOptions {
  fetchImpl?: typeof fetch;
  version?: string;
}

type Step = { ok: true; value: string } | { ok: false; result: PublishResult };

export class LinkedInProvider implements PublishingProvider {
  readonly id = 'linkedin' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly version: string;

  constructor(opts: LinkedInProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.version = opts.version ?? LINKEDIN_API_VERSION;
  }

  capabilities(): ProviderCapabilities {
    return {
      maxTextLength: LINKEDIN_MAX_TEXT,
      maxImages: 1,
      supportedImageMimeTypes: ['image/jpeg', 'image/png'],
      maxImageBytes: LINKEDIN_MAX_IMAGE_BYTES,
    };
  }

  render(post: PostSnapshot, _account: SocialAccountRef): RenderedContent {
    const content = contentForProvider(post.content, this.id);
    const { text, plainText } = renderLittleText(content);
    return {
      text,
      plainText,
      media: content.media.map((m) => ({
        assetId: m.assetId,
        mimeType: 'image/png',
        byteSize: 0,
        ...(m.alt !== undefined ? { alt: m.alt } : {}),
      })),
    };
  }

  validate(content: RenderedContent, _account: SocialAccountRef): ValidationResult {
    const caps = this.capabilities();
    const plain = content.plainText ?? content.text;
    const issues: { code: string; message: string }[] = [];
    if (plain.trim().length === 0)
      issues.push({ code: 'TEXT_EMPTY', message: 'Post text is empty.' });
    if (plain.length > caps.maxTextLength) {
      issues.push({
        code: 'TEXT_TOO_LONG',
        message: `Post text is ${plain.length} characters; LinkedIn allows ${caps.maxTextLength}.`,
      });
    }
    if (content.media.length > caps.maxImages) {
      issues.push({
        code: 'TOO_MANY_IMAGES',
        message: `LinkedIn posts from Postelyo support one image; ${content.media.length} were attached.`,
      });
    }
    for (const m of content.media) {
      if (!caps.supportedImageMimeTypes.includes(m.mimeType)) {
        issues.push({
          code: 'UNSUPPORTED_IMAGE_TYPE',
          message: `Image type ${m.mimeType} is not supported; use JPEG or PNG.`,
        });
      }
      if (m.byteSize > caps.maxImageBytes) {
        issues.push({
          code: 'IMAGE_TOO_LARGE',
          message: `Image is ${(m.byteSize / (1024 * 1024)).toFixed(1)} MB; the limit is 8 MB.`,
        });
      }
    }
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult> {
    const author = authorUrn(input.account);

    // 1. Images first. Uploads are safe to retry; only the final post call can be ambiguous.
    let imageUrn: string | null = null;
    let imageAlt: string | undefined;
    const image = input.content.media[0];
    if (image) {
      const step = await this.ensureImage(image, author, input, ctx);
      if (!step.ok) return step.result;
      imageUrn = step.value;
      imageAlt = image.alt;
    }

    // 2. Create the post.
    const body: Record<string, unknown> = {
      author,
      commentary: input.content.text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(imageUrn
        ? {
            content: {
              media: { id: imageUrn, ...(imageAlt ? { altText: imageAlt.slice(0, 4000) } : {}) },
            },
          }
        : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(LINKEDIN_POSTS_URL, {
        method: 'POST',
        headers: this.headers(ctx, { 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return classifyNetworkError(err, /* sent */ true);
    }

    const text = await res.text().catch(() => '');
    const raw = { status: res.status, body: text.slice(0, 2000) };
    if (res.status === 201 || res.status === 200) {
      const id =
        res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? idFromBody(text);
      if (!id)
        return { kind: 'ambiguous', reason: 'LinkedIn returned success without a post id', raw };
      return {
        kind: 'published',
        providerPostId: id,
        url: `https://www.linkedin.com/feed/update/${id}`,
        raw,
      };
    }
    const message = messageFromBody(text) ?? statusLabel(res);
    if (
      (res.status === 400 || res.status === 422) &&
      /image|media|processing|not available/i.test(message)
    ) {
      // The uploaded image is still processing; the post was not created.
      return {
        kind: 'retryable_error',
        reason: `LinkedIn image not ready yet: ${message}`,
        retryAfterMs: 30_000,
        raw,
      };
    }
    return classifyHttp(res, message, raw, /* postCreation */ true);
  }

  /**
   * Recent posts by the account (Posts API `q=author`), newest first. Used to
   * reconcile ambiguous outcomes; the fingerprint is taken over the unescaped
   * commentary so it matches what we rendered. Verify the finder is available
   * to the app's product tier (member posts need `r_member_social` or the
   * Community Management API; organization posts need `r_organization_social`).
   */
  async lookupRecent(
    account: SocialAccountRef,
    since: Date,
    ctx: ProviderContext,
  ): Promise<ProviderPostRef[]> {
    const u = new URL(LINKEDIN_POSTS_URL);
    u.searchParams.set('q', 'author');
    u.searchParams.set('author', authorUrn(account));
    u.searchParams.set('count', '20');
    u.searchParams.set('sortBy', 'LAST_MODIFIED');
    const res = await this.fetchImpl(u.toString(), {
      method: 'GET',
      headers: this.headers(ctx, { accept: 'application/json' }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(
        `LinkedIn post lookup failed (${res.status}): ${messageFromBody(text) ?? statusLabel(res)}`,
      );
    }
    let parsed: { elements?: unknown };
    try {
      parsed = JSON.parse(text) as { elements?: unknown };
    } catch {
      throw new Error('LinkedIn post lookup returned malformed JSON');
    }
    const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
    const out: ProviderPostRef[] = [];
    for (const raw of elements) {
      const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const id = typeof e['id'] === 'string' ? e['id'] : null;
      if (!id) continue;
      const publishedMs =
        typeof e['publishedAt'] === 'number'
          ? e['publishedAt']
          : typeof e['createdAt'] === 'number'
            ? e['createdAt']
            : null;
      const publishedAt = publishedMs !== null ? new Date(publishedMs) : undefined;
      if (publishedAt && publishedAt.getTime() < since.getTime()) continue;
      const commentary = typeof e['commentary'] === 'string' ? e['commentary'] : '';
      out.push({
        providerPostId: id,
        url: `https://www.linkedin.com/feed/update/${id}`,
        ...(publishedAt ? { publishedAt } : {}),
        textHash: textFingerprint(unescapeLittleText(commentary)),
      });
    }
    return out;
  }

  /** Reuses a cached upload or uploads the bytes: initializeUpload → PUT bytes → image URN. */
  private async ensureImage(
    media: RenderedMedia,
    owner: string,
    input: PublishInput,
    ctx: ProviderContext,
  ): Promise<Step> {
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
      const e = err as { code?: string; message?: string };
      const terminal =
        e.code === 'not_found' ||
        e.code === 'not_an_image' ||
        e.code === 'unsupported_type' ||
        e.code === 'too_large' ||
        e.code === 'blocked_url' ||
        e.code === 'invalid_url';
      return {
        ok: false,
        result: terminal
          ? {
              kind: 'terminal_error',
              code: 'content',
              reason: `Image cannot be used: ${e.message ?? 'unknown error'}`,
            }
          : {
              kind: 'retryable_error',
              reason: `Image download failed: ${e.message ?? 'unknown error'}`,
            },
      };
    }

    // initializeUpload
    let init: Response;
    try {
      init = await this.fetchImpl(LINKEDIN_IMAGES_INIT_URL, {
        method: 'POST',
        headers: this.headers(ctx, { 'content-type': 'application/json' }),
        body: JSON.stringify({ initializeUploadRequest: { owner } }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { ok: false, result: classifyNetworkError(err, false) };
    }
    const initText = await init.text().catch(() => '');
    if (!init.ok) {
      const raw = { status: init.status, body: initText.slice(0, 2000) };
      return {
        ok: false,
        result: classifyHttp(init, messageFromBody(initText) ?? statusLabel(init), raw, false),
      };
    }
    const value = valueFromBody(initText);
    const uploadUrl = typeof value['uploadUrl'] === 'string' ? value['uploadUrl'] : null;
    const imageUrn = typeof value['image'] === 'string' ? value['image'] : null;
    if (!uploadUrl || !imageUrn) {
      return {
        ok: false,
        result: {
          kind: 'retryable_error',
          reason: 'LinkedIn initializeUpload response incomplete',
        },
      };
    }

    // PUT bytes
    let put: Response;
    try {
      put = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.credentials.accessToken}`,
          'content-type': 'application/octet-stream',
        },
        body: loaded.bytes,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { ok: false, result: classifyNetworkError(err, false) };
    }
    if (!put.ok) {
      const putText = await put.text().catch(() => '');
      const raw = { status: put.status, body: putText.slice(0, 500) };
      if (put.status === 401 || put.status === 403) {
        return {
          ok: false,
          result: {
            kind: 'terminal_error',
            code: 'auth',
            reason: `Image upload rejected (${put.status})`,
            raw,
          },
        };
      }
      return {
        ok: false,
        result: { kind: 'retryable_error', reason: `Image upload failed (${put.status})`, raw },
      };
    }
    await input.onMediaUploaded?.(media.assetId, imageUrn, loaded.contentHash);
    return { ok: true, value: imageUrn };
  }

  private headers(ctx: ProviderContext, extra: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${ctx.credentials.accessToken}`,
      'linkedin-version': this.version,
      'x-restli-protocol-version': '2.0.0',
      ...extra,
    };
  }
}

function classifyHttp(
  res: Response,
  message: string,
  raw: unknown,
  postCreation: boolean,
): PublishResult {
  switch (res.status) {
    case 401:
      return {
        kind: 'terminal_error',
        code: 'auth',
        reason: `LinkedIn rejected the access token: ${message}`,
        raw,
      };
    case 403:
      return /permission|scope|access denied|not authorized/i.test(message)
        ? {
            kind: 'terminal_error',
            code: 'permission',
            reason: `LinkedIn denied permission: ${message}`,
            raw,
          }
        : {
            kind: 'terminal_error',
            code: 'auth',
            reason: `LinkedIn forbade the request: ${message}`,
            raw,
          };
    case 400:
    case 409:
    case 422:
      return {
        kind: 'terminal_error',
        code: 'content',
        reason: `LinkedIn rejected the post: ${message}`,
        raw,
      };
    case 429: {
      // LinkedIn throttles per member/organization per day and per app; the
      // engine treats this as a wait rather than a failed attempt.
      const ra = Number(res.headers.get('retry-after'));
      return {
        kind: 'retryable_error',
        code: 'rate_limit',
        reason: `LinkedIn rate limit reached${message ? `: ${message}` : ''}`,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : LINKEDIN_RATE_LIMIT_WAIT_MS,
        raw,
      };
    }
    case 502:
    case 503:
    case 504:
      return { kind: 'retryable_error', reason: `LinkedIn unavailable (${res.status})`, raw };
    default:
      // For the post call a 500 may have created the post → fail closed. Uploads are safe to retry.
      return postCreation
        ? {
            kind: 'ambiguous',
            reason: `Unexpected LinkedIn response ${res.status}: ${message}`,
            raw,
          }
        : {
            kind: 'retryable_error',
            reason: `Unexpected LinkedIn response ${res.status}: ${message}`,
            raw,
          };
  }
}

function classifyNetworkError(err: unknown, sent: boolean): PublishResult {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? '';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || !sent) {
    return {
      kind: 'retryable_error',
      reason: `LinkedIn unreachable (${code || e.name || 'network error'})`,
    };
  }
  // Timeouts, aborts and resets on the post call: the request may have been processed.
  const label = e.name ?? (code.length > 0 ? code : 'network error');
  return { kind: 'ambiguous', reason: `No response from LinkedIn (${label})` };
}

/** `urn:li:person:{sub}` for profiles, `urn:li:organization:{id}` for pages. */
export function authorUrn(account: Pick<SocialAccountRef, 'accountType' | 'providerAccountId'>) {
  return account.accountType === 'organization'
    ? `urn:li:organization:${account.providerAccountId}`
    : `urn:li:person:${account.providerAccountId}`;
}

function statusLabel(res: Response): string {
  return res.statusText.length > 0 ? res.statusText : `HTTP ${res.status}`;
}

function idFromBody(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}

function valueFromBody(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { value?: unknown };
    return typeof parsed.value === 'object' && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function messageFromBody(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; code?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.code === 'string') return parsed.code;
    return null;
  } catch {
    return null;
  }
}
