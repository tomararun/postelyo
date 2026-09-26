import { contentForProvider, contentToPlainText, textFingerprint } from '../../render.js';
import type {
  LoadedMedia,
  MediaUrl,
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

export interface FakeProviderOptions {
  /** Scripted outcomes consumed in order; after the script is exhausted, publishes succeed. */
  script?: PublishResult[];
  /** Or decide per call (takes precedence over `script`). */
  decide?: (input: PublishInput, callNo: number) => PublishResult;
  capabilities?: Partial<ProviderCapabilities>;
  /** Simulated latency per call. */
  latencyMs?: number;
  /** Provider id whose per-platform text override the fake should honour (default: `fake`). */
  renderAs?: string;
}

export interface FakeCall {
  input: PublishInput;
  correlationId: string;
  result: PublishResult;
  /** Media the fake "uploaded" during this call (reused refs are not re-uploaded). */
  uploaded: { assetId: string; byteSize: number; contentHash: string; ref: string }[];
  reusedRefs: string[];
  /** Public variant URLs resolved during this call (url-delivery fakes). */
  urls: ({ assetId: string } & MediaUrl)[];
}

/**
 * In-memory provider for local development and tests (architecture §9.1, §17).
 * Records every call so tests can assert exactly-once behaviour and media reuse.
 */
export class FakeProvider implements PublishingProvider {
  readonly id = 'fake' as const;
  readonly calls: FakeCall[] = [];
  /** What `lookupRecent` returns, keyed by account id; tests seed it. */
  readonly recentPosts = new Map<string, ProviderPostRef[]>();
  /** When set, `lookupRecent` throws (simulates a lookup outage). */
  lookupError: Error | null = null;
  private readonly script: PublishResult[];
  private seq = 0;

  constructor(private readonly opts: FakeProviderOptions = {}) {
    this.script = [...(opts.script ?? [])];
  }

  /** Appends scripted outcomes consumed by subsequent publish calls (tests). */
  scriptOutcomes(...results: PublishResult[]): void {
    this.script.push(...results);
  }

  /** Seeds a provider-side post for `lookupRecent`, fingerprinted like a real adapter would. */
  seedRecentPost(
    accountId: string,
    input: { providerPostId: string; text: string; publishedAt: Date; url?: string },
  ): void {
    const list = this.recentPosts.get(accountId) ?? [];
    list.push({
      providerPostId: input.providerPostId,
      url: input.url ?? `https://fake.postelyo.local/recent/${input.providerPostId}`,
      publishedAt: input.publishedAt,
      textHash: textFingerprint(input.text),
    });
    this.recentPosts.set(accountId, list);
  }

  async lookupRecent(
    account: SocialAccountRef,
    since: Date,
    _ctx: ProviderContext,
  ): Promise<ProviderPostRef[]> {
    if (this.lookupError) throw this.lookupError;
    return (this.recentPosts.get(account.id) ?? []).filter(
      (p) => !p.publishedAt || p.publishedAt.getTime() >= since.getTime(),
    );
  }

  capabilities(): ProviderCapabilities {
    return {
      maxTextLength: 3000,
      maxImages: 1,
      supportedImageMimeTypes: ['image/jpeg', 'image/png'],
      maxImageBytes: 8 * 1024 * 1024,
      ...this.opts.capabilities,
    };
  }

  render(post: PostSnapshot, account?: SocialAccountRef): RenderedContent {
    // As the fallback for every provider in PROVIDER_MODE=fake, render the override of the
    // account's real provider so per-platform text is exercised end to end.
    const content = contentForProvider(
      post.content,
      this.opts.renderAs ?? account?.provider ?? this.id,
    );
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
    const caps = this.capabilities();
    const issues: { code: string; message: string }[] = [];
    if (content.text.trim().length === 0) {
      issues.push({ code: 'TEXT_EMPTY', message: 'Post text is empty' });
    }
    if (content.text.length > caps.maxTextLength) {
      issues.push({
        code: 'TEXT_TOO_LONG',
        message: `Post text is ${content.text.length} characters; limit is ${caps.maxTextLength}`,
      });
    }
    if (content.media.length > caps.maxImages) {
      issues.push({
        code: 'TOO_MANY_IMAGES',
        message: `At most ${caps.maxImages} image(s) allowed`,
      });
    }
    for (const m of content.media) {
      if (!caps.supportedImageMimeTypes.includes(m.mimeType)) {
        issues.push({
          code: 'UNSUPPORTED_IMAGE_TYPE',
          message: `Image type ${m.mimeType} is not supported`,
        });
      }
      if (m.byteSize > caps.maxImageBytes) {
        issues.push({
          code: 'IMAGE_TOO_LARGE',
          message: `Image exceeds ${caps.maxImageBytes} bytes`,
        });
      }
    }
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  }

  async publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    if (ctx.signal?.aborted) {
      return { kind: 'ambiguous', reason: 'aborted before response' };
    }
    const callNo = this.calls.length;
    const call: FakeCall = {
      input,
      correlationId: ctx.correlationId,
      result: { kind: 'ambiguous', reason: 'not decided' },
      uploaded: [],
      reusedRefs: [],
      urls: [],
    };
    this.calls.push(call);

    // Media: mirror a real adapter — reuse cached refs, otherwise load and "upload";
    // url-delivery fakes ask the engine for a public variant instead.
    const spec = this.capabilities().image;
    for (const m of input.content.media) {
      if (spec?.delivery === 'url') {
        if (!input.mediaUrl) continue;
        try {
          const resolved = await input.mediaUrl(m.assetId, spec);
          call.urls.push({ assetId: m.assetId, ...resolved });
        } catch (err) {
          call.result = {
            kind: 'retryable_error',
            reason: `media url failed: ${(err as Error).message}`,
          };
          return call.result;
        }
        continue;
      }
      if (m.providerRef) {
        call.reusedRefs.push(m.providerRef);
        continue;
      }
      if (!input.loadMedia) continue;
      let loaded: LoadedMedia;
      try {
        loaded = await input.loadMedia(m.assetId);
      } catch (err) {
        call.result = {
          kind: 'retryable_error',
          reason: `media load failed: ${(err as Error).message}`,
        };
        return call.result;
      }
      const ref = `fake:image:${loaded.contentHash.slice(0, 12)}`;
      call.uploaded.push({
        assetId: m.assetId,
        byteSize: loaded.byteSize,
        contentHash: loaded.contentHash,
        ref,
      });
      await input.onMediaUploaded?.(m.assetId, ref, loaded.contentHash);
    }

    call.result = this.opts.decide?.(input, callNo) ??
      this.script.shift() ?? {
        kind: 'published',
        providerPostId: `fake:${input.account.providerAccountId}:${++this.seq}`,
        url: `https://fake.postelyo.local/posts/${input.publicationId}`,
      };
    return call.result;
  }
}
