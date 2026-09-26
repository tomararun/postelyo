import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  publishAttempt,
  socialAccount,
  type Publication,
  type SocialAccount,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import {
  blockAccountPublications,
  markAccountNeedsReauth,
} from '../connections/account-blocking.js';
import type { SocialAccountService } from '../connections/social-account.service.js';
import { MediaError } from '../media/media-fetcher.js';
import { enrichRenderedMedia, type MediaService } from '../media/media.service.js';
import type { CanonicalContent, PostSnapshot } from '../posts/content.js';
import { recomputePostState } from '../posts/post-state.js';
import { assertPublicationTransition } from '../posts/state-machine.js';
import { systemContext, type TenantContext } from '../tenancy/tenant-context.js';
import { backoffMs } from './backoff.js';
import type { JobEnqueuer, PublishJobData } from './jobs.js';
import type { PublishResult, SocialAccountRef } from './provider.js';
import type { ProviderRegistry } from './registry.js';

export type PublishOutcome = 'skipped' | 'published' | 'retry_scheduled' | 'failed' | 'ambiguous';

export interface PublishEngineDeps {
  db: Db;
  providers: ProviderRegistry;
  socialAccounts: SocialAccountService;
  media: MediaService;
  enqueue: JobEnqueuer;
  clock: Clock;
  logger: Logger;
  workerId: string;
  /** Lease duration; the sweeper marks expired leases ambiguous (architecture §9.2). */
  leaseMs?: number;
  providerTimeoutMs?: number;
  random?: () => number;
}

export const DEFAULT_LEASE_MS = 2 * 60_000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
/** Waits after a provider rate limit: default when no Retry-After, and the longest we honour. */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 15 * 60_000;
export const RATE_LIMIT_MAX_WAIT_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_META_BYTES = 4 * 1024;

/**
 * Publish job handler (architecture §9.2). Exactly-once guarantees come from
 * the conditional lease update: whoever wins it calls the provider; everyone
 * else exits. Unknown outcomes fail closed into `ambiguous` and never retry.
 */
export class PublishEngine {
  private readonly leaseMs: number;
  private readonly providerTimeoutMs: number;

  constructor(private readonly deps: PublishEngineDeps) {
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.providerTimeoutMs = deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async handle(job: PublishJobData, correlationId: string): Promise<PublishOutcome> {
    const { db } = this.deps;
    const now = this.deps.clock.now();

    // 1. Lease. Only queued (or due retry_wait) rows of the expected cycle can be claimed.
    const [before] = await db
      .select()
      .from(publication)
      .where(eq(publication.id, job.publicationId))
      .limit(1);
    if (!before) return 'skipped';
    const [leased] = await db
      .update(publication)
      .set({
        state: 'publishing',
        leaseOwner: this.deps.workerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        attemptNo: sql`${publication.attemptNo} + 1`,
        publishingAt: now,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(publication.id, job.publicationId),
          eq(publication.cycleNo, job.cycleNo),
          or(
            eq(publication.state, 'queued'),
            and(eq(publication.state, 'retry_wait'), lte(publication.nextAttemptAt, now)),
          ),
        ),
      )
      .returning();
    if (!leased) {
      this.deps.logger.info(
        { publicationId: job.publicationId, state: before.state, cycleNo: before.cycleNo },
        'publish job skipped: lease not acquired',
      );
      return 'skipped';
    }
    const ctx = systemContext(leased.workspaceId, 'publish', correlationId);
    await recordAudit(db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'publication',
      entityId: leased.id,
      event: 'publication.state_changed',
      fromState: before.state,
      toState: 'publishing',
      correlationId,
      data: {
        attemptNo: leased.attemptNo,
        cycleNo: leased.cycleNo,
        leaseOwner: this.deps.workerId,
      },
    });
    await this.deps.enqueue.writeback({ publicationId: leased.id }).catch(() => undefined);

    // 2. Load snapshot and account.
    const [postRow] = await db.select().from(post).where(eq(post.id, leased.postId)).limit(1);
    const [account] = await db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, leased.socialAccountId))
      .limit(1);
    const attemptId = uuidv7();
    await db.insert(publishAttempt).values({
      id: attemptId,
      workspaceId: leased.workspaceId,
      publicationId: leased.id,
      cycleNo: leased.cycleNo,
      attemptNo: leased.attemptNo,
      startedAt: now,
      scheduledAt: leased.scheduledAt,
      workerId: this.deps.workerId,
      requestMeta: {
        correlationId,
        provider: leased.provider,
        contentHash: postRow?.contentHash ?? null,
      },
    });

    if (!postRow || !account) {
      return this.finish(ctx, leased, attemptId, {
        kind: 'terminal_error',
        code: 'other',
        reason: !postRow ? 'post snapshot missing' : 'social account missing',
      });
    }
    if (account.status !== 'active' || account.disconnectedAt || !account.accessTokenEnc) {
      return this.finish(ctx, leased, attemptId, {
        kind: 'terminal_error',
        code: 'auth',
        reason: 'The social account is not active; re-authorize the connection and schedule again.',
      });
    }

    // 3. Render, enrich media metadata, validate, publish.
    const provider = this.deps.providers.get(account.provider);
    const ref = accountRef(account);
    const content = postRow.content as CanonicalContent;
    const snapshot: PostSnapshot = {
      postId: postRow.id,
      workspaceId: postRow.workspaceId,
      title: postRow.title,
      content,
      contentHash: postRow.contentHash,
    };
    const mediaRows = await this.deps.media.rowsFor(content.media.map((m) => m.assetId));
    const sourceRef =
      postRow.contentSourceId && postRow.externalId
        ? { contentSourceId: postRow.contentSourceId, externalPageId: postRow.externalId }
        : null;

    let result: PublishResult;
    try {
      const rendered = enrichRenderedMedia(
        provider.render(snapshot, ref),
        mediaRows,
        account.provider,
      );
      const validation = provider.validate(rendered, ref);
      if (!validation.ok) {
        result = {
          kind: 'terminal_error',
          code: 'content',
          reason: validation.issues.map((i) => i.message).join(' '),
        };
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.providerTimeoutMs);
        try {
          result = await this.deps.socialAccounts.withAccessToken(
            ctx,
            account.id,
            'publish',
            (accessToken) =>
              provider.publish(
                {
                  publicationId: leased.id,
                  account: ref,
                  content: rendered,
                  loadMedia: async (assetId) => {
                    const row = mediaRows.get(assetId);
                    if (!row) throw new MediaError('not_found', `media asset ${assetId} missing`);
                    return this.deps.media.load(ctx, row, sourceRef);
                  },
                  onMediaUploaded: (assetId, providerRef, contentHash) =>
                    this.deps.media.recordProviderRef(
                      assetId,
                      account.provider,
                      providerRef,
                      contentHash,
                    ),
                },
                {
                  credentials: { accessToken },
                  correlationId,
                  timeoutMs: this.providerTimeoutMs,
                  signal: controller.signal,
                },
              ),
          );
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      // An adapter must classify everything; an exception here is our bug, and the
      // provider call may or may not have happened → fail closed.
      this.deps.logger.error({ err, publicationId: leased.id }, 'publish engine internal error');
      result = { kind: 'ambiguous', reason: `internal error: ${(err as Error).message}` };
    }
    return this.finish(ctx, leased, attemptId, result);
  }

  private async finish(
    ctx: TenantContext,
    leased: Publication,
    attemptId: string,
    result: PublishResult,
  ): Promise<PublishOutcome> {
    const { db } = this.deps;
    const now = this.deps.clock.now();
    const responseMeta = truncateMeta(result.raw);
    let outcome: PublishOutcome = 'ambiguous';
    let retryAt: Date | null = null;

    await db.transaction(async (tx) => {
      const base = { leaseOwner: null, leaseExpiresAt: null, updatedAt: now };
      switch (result.kind) {
        case 'published': {
          assertPublicationTransition('publishing', 'published');
          const delaySeconds = Math.max(
            0,
            Math.floor((now.getTime() - leased.scheduledAt.getTime()) / 1000),
          );
          await tx
            .update(publication)
            .set({
              ...base,
              state: 'published',
              publishedAt: now,
              delaySeconds,
              providerPostId: result.providerPostId,
              providerPostUrl: result.url ?? null,
              lastErrorCode: null,
              lastErrorMessage: null,
              writebackState: 'pending',
            })
            .where(eq(publication.id, leased.id));
          await tx
            .update(publishAttempt)
            .set({ finishedAt: now, outcome: 'succeeded', delaySeconds, responseMeta })
            .where(eq(publishAttempt.id, attemptId));
          await recordAudit(tx, {
            workspaceId: ctx.workspaceId,
            actor: ctx.actor,
            entityType: 'publication',
            entityId: leased.id,
            event: 'publication.state_changed',
            fromState: 'publishing',
            toState: 'published',
            correlationId: ctx.correlationId,
            data: {
              scheduledAt: leased.scheduledAt.toISOString(),
              publishedAt: now.toISOString(),
              delaySeconds,
              providerPostId: result.providerPostId,
              attemptNo: leased.attemptNo,
            },
          });
          await tx
            .update(socialAccount)
            .set({ lastUsedAt: now })
            .where(eq(socialAccount.id, leased.socialAccountId));
          outcome = 'published';
          break;
        }
        case 'retryable_error': {
          const rateLimited = result.code === 'rate_limit';
          // A rate limit is a wait, not a failed attempt: it never consumes the attempt budget.
          const canRetry = rateLimited || leased.attemptNo < leased.maxAttempts;
          if (canRetry) {
            assertPublicationTransition('publishing', 'retry_wait');
            const delay = rateLimited
              ? Math.min(result.retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS, RATE_LIMIT_MAX_WAIT_MS)
              : backoffMs({
                  attemptNo: leased.attemptNo,
                  retryAfterMs: result.retryAfterMs,
                  ...(this.deps.random ? { random: this.deps.random } : {}),
                });
            retryAt = new Date(now.getTime() + delay);
            const errorCode = rateLimited ? 'rate_limited' : 'transient';
            await tx
              .update(publication)
              .set({
                ...base,
                state: 'retry_wait',
                nextAttemptAt: retryAt,
                ...(rateLimited ? { attemptNo: leased.attemptNo - 1 } : {}),
                lastErrorCode: errorCode,
                lastErrorMessage: result.reason,
                writebackState: 'pending',
              })
              .where(eq(publication.id, leased.id));
            await tx
              .update(publishAttempt)
              .set({
                finishedAt: now,
                outcome: 'failed_retryable',
                errorCode,
                errorMessage: result.reason,
                responseMeta,
              })
              .where(eq(publishAttempt.id, attemptId));
            await recordAudit(tx, {
              workspaceId: ctx.workspaceId,
              actor: ctx.actor,
              entityType: 'publication',
              entityId: leased.id,
              event: 'publication.state_changed',
              fromState: 'publishing',
              toState: 'retry_wait',
              correlationId: ctx.correlationId,
              data: {
                attemptNo: leased.attemptNo,
                nextAttemptAt: retryAt.toISOString(),
                reason: result.reason,
                rateLimited,
              },
            });
            outcome = 'retry_scheduled';
          } else {
            await this.markFailed(
              tx,
              ctx,
              leased,
              attemptId,
              'transient',
              `Gave up after ${leased.attemptNo} attempts: ${result.reason}`,
              responseMeta,
              now,
            );
            outcome = 'failed';
          }
          break;
        }
        case 'terminal_error': {
          await this.markFailed(
            tx,
            ctx,
            leased,
            attemptId,
            result.code,
            result.reason,
            responseMeta,
            now,
          );
          if (result.code === 'auth') await this.blockAccount(tx, ctx, leased, now);
          outcome = 'failed';
          break;
        }
        case 'ambiguous': {
          assertPublicationTransition('publishing', 'ambiguous');
          await tx
            .update(publication)
            .set({
              ...base,
              state: 'ambiguous',
              lastErrorCode: 'ambiguous',
              lastErrorMessage: result.reason,
              writebackState: 'pending',
            })
            .where(eq(publication.id, leased.id));
          await tx
            .update(publishAttempt)
            .set({
              finishedAt: now,
              outcome: 'unknown',
              errorCode: 'ambiguous',
              errorMessage: result.reason,
              responseMeta,
            })
            .where(eq(publishAttempt.id, attemptId));
          await recordAudit(tx, {
            workspaceId: ctx.workspaceId,
            actor: ctx.actor,
            entityType: 'publication',
            entityId: leased.id,
            event: 'publication.state_changed',
            fromState: 'publishing',
            toState: 'ambiguous',
            correlationId: ctx.correlationId,
            data: { attemptNo: leased.attemptNo, reason: result.reason },
          });
          this.deps.logger.error(
            { publicationId: leased.id, workspaceId: ctx.workspaceId, reason: result.reason },
            'ALERT publication ambiguous: provider outcome unknown, manual review required',
          );
          outcome = 'ambiguous';
          break;
        }
      }
      await recomputePostState(tx, ctx, leased.postId);
    });

    if (retryAt) {
      await this.deps.enqueue.publish(
        { publicationId: leased.id, cycleNo: leased.cycleNo },
        { startAfter: retryAt },
      );
    }
    await this.deps.enqueue.writeback({ publicationId: leased.id }).catch((err: unknown) => {
      this.deps.logger.warn({ err, publicationId: leased.id }, 'could not enqueue writeback');
    });
    return outcome;
  }

  private async markFailed(
    tx: Pick<Db, 'update' | 'insert' | 'select'>,
    ctx: TenantContext,
    leased: Publication,
    attemptId: string,
    code: string,
    message: string,
    responseMeta: unknown,
    now: Date,
  ): Promise<void> {
    assertPublicationTransition('publishing', 'failed');
    await tx
      .update(publication)
      .set({
        state: 'failed',
        failedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: code,
        lastErrorMessage: message,
        writebackState: 'pending',
        updatedAt: now,
      })
      .where(eq(publication.id, leased.id));
    await tx
      .update(publishAttempt)
      .set({
        finishedAt: now,
        outcome: 'failed_terminal',
        errorCode: code,
        errorMessage: message,
        responseMeta,
      })
      .where(eq(publishAttempt.id, attemptId));
    await recordAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'publication',
      entityId: leased.id,
      event: 'publication.state_changed',
      fromState: 'publishing',
      toState: 'failed',
      correlationId: ctx.correlationId,
      data: { attemptNo: leased.attemptNo, code, message },
    });
  }

  /** Auth failure: the account needs re-authorization; park its other waiting publications (architecture §6.3). */
  private async blockAccount(
    tx: Pick<Db, 'update' | 'insert' | 'select'>,
    ctx: TenantContext,
    leased: Publication,
    now: Date,
  ): Promise<void> {
    await markAccountNeedsReauth(tx, ctx, leased.socialAccountId, 'publish_auth_error', now);
    await blockAccountPublications(tx, ctx, leased.socialAccountId, 'account_needs_reauth', now);
  }
}

export function accountRef(a: SocialAccount): SocialAccountRef {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    provider: a.provider,
    accountType: a.accountType === 'organization' ? 'organization' : 'member',
    providerAccountId: a.providerAccountId,
    displayName: a.displayName,
  };
}

function truncateMeta(raw: unknown): unknown {
  if (raw === undefined) return null;
  try {
    const s = JSON.stringify(raw);
    if (s.length <= MAX_RESPONSE_META_BYTES) return raw;
    return { truncated: true, preview: s.slice(0, MAX_RESPONSE_META_BYTES) };
  } catch {
    return { unserializable: true };
  }
}
