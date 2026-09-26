import type { BlockNode, CanonicalContent, InlineNode, PostSnapshot } from './content.js';

/**
 * Publishing provider contract (architecture §9.1). Adapters are pure I/O
 * translators: no database access, no state transitions, credentials only for
 * the duration of a call. Every outcome maps to exactly one PublishResult kind.
 */

export type ProviderId = 'linkedin' | 'x' | 'instagram' | 'facebook' | 'fake';

/**
 * `member` = personal profile, `organization` = company page (LinkedIn),
 * `page` = Facebook Page, `business` = Instagram professional account.
 */
export type AccountType = 'member' | 'organization' | 'page' | 'business';

/**
 * How an adapter takes images. `upload` adapters receive bytes through
 * `loadMedia`; `url` adapters receive a public URL of a derived variant that
 * satisfies the spec through `mediaUrl` (Instagram, Facebook).
 */
export interface ImageSpec {
  delivery: 'upload' | 'url';
  /** Output type for derived variants; the engine converts when needed. */
  outputMimeType?: 'image/jpeg' | 'image/png';
  minWidth?: number;
  maxWidth?: number;
  /** Allowed width / height range; the engine crops toward the nearest bound. */
  minAspect?: number;
  maxAspect?: number;
}

export interface ProviderCapabilities {
  maxTextLength: number;
  maxImages: number;
  supportedImageMimeTypes: readonly string[];
  maxImageBytes: number;
  /** Defaults to `{ delivery: 'upload' }` when omitted. */
  image?: ImageSpec;
  /** Provider refuses posts without an image (Instagram). */
  imageRequired?: boolean;
}

/** What the engine knows about the target account; never contains secrets. */
export interface SocialAccountRef {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  accountType: AccountType;
  providerAccountId: string;
  displayName: string;
}

/** Decrypted credentials, scoped to a single call. */
export interface ProviderCredentials {
  accessToken: string;
}

export interface ProviderContext {
  credentials: ProviderCredentials;
  correlationId: string;
  /** Wall-clock deadline for the whole publish call. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RenderedMedia {
  assetId: string;
  mimeType: string;
  byteSize: number;
  alt?: string;
  /** sha256 of the bytes as last inspected; lets adapters reason about reuse. */
  contentHash?: string;
  /** Provider-side reference if these exact bytes were already uploaded (idempotent re-use). */
  providerRef?: string;
  width?: number;
  height?: number;
}

export interface RenderedContent {
  /** Provider-specific text (e.g. LinkedIn "little text" with escaping). */
  text: string;
  /** Human-visible text when `text` contains markup; used for length validation. */
  plainText?: string;
  media: RenderedMedia[];
}

/** Bytes handed to an adapter for upload. */
export interface LoadedMedia {
  assetId: string;
  bytes: Uint8Array;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  fileName?: string;
}

/** A publicly reachable derived image for `url` delivery adapters. */
export interface MediaUrl {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

export type ValidationIssue = { code: string; message: string };
export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

export interface PublishInput {
  publicationId: string;
  account: SocialAccountRef;
  content: RenderedContent;
  /** Loads media bytes on demand; adapters must not cache across calls. */
  loadMedia?: (assetId: string) => Promise<LoadedMedia>;
  /** Public URL of a variant meeting `spec`; for `url` delivery adapters. */
  mediaUrl?: (assetId: string, spec: ImageSpec) => Promise<MediaUrl>;
  /** Called after a successful provider upload so the engine can cache the reference. */
  onMediaUploaded?: (assetId: string, providerRef: string, contentHash: string) => Promise<void>;
}

export type TerminalErrorCode = 'auth' | 'content' | 'permission' | 'rate_limit_daily' | 'other';

/**
 * `rate_limit` retryable errors are waits, not failures: the engine honours
 * `retryAfterMs` beyond the normal backoff cap and does not count the attempt
 * against `max_attempts` (architecture §10.2, Phase 1 rate-limit awareness).
 */
export type RetryableErrorCode = 'transient' | 'rate_limit';

export type PublishResult =
  | { kind: 'published'; providerPostId: string; url?: string; raw?: unknown }
  | {
      kind: 'retryable_error';
      reason: string;
      code?: RetryableErrorCode;
      retryAfterMs?: number;
      raw?: unknown;
    }
  | { kind: 'terminal_error'; reason: string; code: TerminalErrorCode; raw?: unknown }
  | { kind: 'ambiguous'; reason: string; raw?: unknown };

/** A post seen at the provider; used to reconcile `ambiguous` outcomes. */
export interface ProviderPostRef {
  providerPostId: string;
  url?: string;
  publishedAt?: Date;
  /** `textFingerprint()` of the post text as the provider returns it. */
  textHash?: string;
}

export interface PublishingProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  render(post: PostSnapshot, account: SocialAccountRef): RenderedContent;
  validate(content: RenderedContent, account: SocialAccountRef): ValidationResult;
  publish(input: PublishInput, ctx: ProviderContext): Promise<PublishResult>;
  /**
   * Optional: recent posts of the account published at or after `since`, for
   * reconciling `ambiguous` outcomes. Throws on transport failure; the caller
   * treats that as "could not check" and tries again later.
   */
  lookupRecent?(
    account: SocialAccountRef,
    since: Date,
    ctx: ProviderContext,
  ): Promise<ProviderPostRef[]>;
  /** Optional: revoke the token at the provider on disconnect (best effort). */
  revoke?(account: SocialAccountRef, ctx: ProviderContext): Promise<void>;
}

/** Content types re-exported so adapters depend on this contract only. */
export type { BlockNode, CanonicalContent, InlineNode, PostSnapshot };
