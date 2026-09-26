import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  publishAttempt,
  type Publication,
  type PublishAttempt,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { recomputePostState } from '../posts/post-state.js';
import { assertPublicationTransition } from '../posts/state-machine.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { JobEnqueuer } from './jobs.js';

export class PublicationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'PublicationError';
  }
}

export interface PublicationDto {
  id: string;
  postId: string;
  socialAccountId: string;
  provider: Publication['provider'];
  state: Publication['state'];
  scheduledAt: Date;
  scheduledTz: string;
  scheduledLocal: string;
  cycleNo: number;
  attemptNo: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
  delaySeconds: number | null;
  providerPostId: string | null;
  providerPostUrl: string | null;
  deferredUntil: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  writebackState: Publication['writebackState'];
  attempts: {
    attemptNo: number;
    cycleNo: number;
    startedAt: Date;
    finishedAt: Date | null;
    outcome: PublishAttempt['outcome'];
    errorCode: string | null;
    errorMessage: string | null;
    workerId: string;
  }[];
}

export interface ResolveInput {
  outcome: 'published' | 'failed';
  providerPostId?: string | undefined;
  providerPostUrl?: string | undefined;
  /** When the provider reports the real publish time (reconciliation); defaults to now. */
  publishedAt?: Date | undefined;
  /** Audit reason; operator by default, `reconciliation` for the automatic path. */
  reason?: 'operator_resolution' | 'reconciliation' | undefined;
}

/** Operator actions on publications (PRD §4.8): inspect, retry, resolve ambiguous. */
export class PublicationService {
  constructor(
    private readonly db: Db,
    private readonly enqueue: JobEnqueuer,
    private readonly clock: Clock,
  ) {}

  async get(ctx: TenantContext, id: string): Promise<PublicationDto | null> {
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(publication)
        .where(and(eq(publication.workspaceId, ctx.workspaceId), eq(publication.id, id)))
        .limit(1);
      if (!row) return null;
      const attempts = await tx
        .select()
        .from(publishAttempt)
        .where(eq(publishAttempt.publicationId, id))
        .orderBy(asc(publishAttempt.startedAt));
      return toDto(row, attempts);
    });
  }

  /** Manual retry of a failed publication: new cycle, due immediately (architecture §10.3). */
  async retry(ctx: TenantContext, id: string): Promise<PublicationDto> {
    const now = this.clock.now();
    await withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(publication)
        .where(and(eq(publication.workspaceId, ctx.workspaceId), eq(publication.id, id)))
        .limit(1)
        .for('update');
      if (!row) throw new PublicationError('not_found', 'publication not found');
      if (row.state !== 'failed') {
        throw new PublicationError(
          'invalid_state',
          `only failed publications can be retried (state is ${row.state})`,
        );
      }
      assertPublicationTransition(row.state, 'scheduled');
      const cycleNo = row.cycleNo + 1;
      await tx
        .update(publication)
        .set({
          state: 'scheduled',
          scheduledAt: now,
          cycleNo,
          attemptNo: 0,
          nextAttemptAt: null,
          queuedAt: null,
          publishingAt: null,
          failedAt: null,
          deferredUntil: null,
          reconcileAttempts: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          writebackState: 'pending',
          writebackAttempts: 0,
          updatedAt: now,
        })
        .where(eq(publication.id, id));
      await tx.update(post).set({ cycleNo, updatedAt: now }).where(eq(post.id, row.postId));
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'publication',
        entityId: id,
        event: 'publication.state_changed',
        fromState: 'failed',
        toState: 'scheduled',
        correlationId: ctx.correlationId,
        data: { reason: 'operator_retry', cycleNo, scheduledAt: now.toISOString() },
      });
      await recomputePostState(tx, ctx, row.postId);
    });
    return (await this.get(ctx, id))!;
  }

  /** Operator resolution of an ambiguous outcome after checking the provider (architecture §7.2). */
  async resolve(ctx: TenantContext, id: string, input: ResolveInput): Promise<PublicationDto> {
    const now = this.clock.now();
    const reason = input.reason ?? 'operator_resolution';
    await withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(publication)
        .where(and(eq(publication.workspaceId, ctx.workspaceId), eq(publication.id, id)))
        .limit(1)
        .for('update');
      if (!row) throw new PublicationError('not_found', 'publication not found');
      if (row.state !== 'ambiguous') {
        throw new PublicationError(
          'invalid_state',
          `only ambiguous publications can be resolved (state is ${row.state})`,
        );
      }
      assertPublicationTransition('ambiguous', input.outcome);
      if (input.outcome === 'published') {
        const publishedAt = input.publishedAt ?? now;
        const delaySeconds = Math.max(
          0,
          Math.floor((publishedAt.getTime() - row.scheduledAt.getTime()) / 1000),
        );
        await tx
          .update(publication)
          .set({
            state: 'published',
            publishedAt,
            delaySeconds,
            providerPostId: input.providerPostId ?? `manual:${id}`,
            providerPostUrl: input.providerPostUrl ?? null,
            lastErrorCode: null,
            lastErrorMessage: null,
            writebackState: 'pending',
            updatedAt: now,
          })
          .where(eq(publication.id, id));
      } else {
        await tx
          .update(publication)
          .set({
            state: 'failed',
            failedAt: now,
            lastErrorCode: 'ambiguous_resolved',
            lastErrorMessage:
              reason === 'reconciliation'
                ? 'The provider confirmed the post was not published.'
                : 'Operator confirmed the post was not published.',
            writebackState: 'pending',
            updatedAt: now,
          })
          .where(eq(publication.id, id));
      }
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'publication',
        entityId: id,
        event: 'publication.state_changed',
        fromState: 'ambiguous',
        toState: input.outcome,
        correlationId: ctx.correlationId,
        data: { reason, providerPostId: input.providerPostId ?? null },
      });
      await recomputePostState(tx, ctx, row.postId);
    });
    await this.enqueue.writeback({ publicationId: id });
    return (await this.get(ctx, id))!;
  }
}

function toDto(p: Publication, attempts: PublishAttempt[]): PublicationDto {
  return {
    id: p.id,
    postId: p.postId,
    socialAccountId: p.socialAccountId,
    provider: p.provider,
    state: p.state,
    scheduledAt: p.scheduledAt,
    scheduledTz: p.scheduledTz,
    scheduledLocal: p.scheduledLocal,
    cycleNo: p.cycleNo,
    attemptNo: p.attemptNo,
    maxAttempts: p.maxAttempts,
    nextAttemptAt: p.nextAttemptAt,
    publishedAt: p.publishedAt,
    delaySeconds: p.delaySeconds,
    providerPostId: p.providerPostId,
    providerPostUrl: p.providerPostUrl,
    deferredUntil: p.deferredUntil,
    lastErrorCode: p.lastErrorCode,
    lastErrorMessage: p.lastErrorMessage,
    writebackState: p.writebackState,
    attempts: attempts.map((a) => ({
      attemptNo: a.attemptNo,
      cycleNo: a.cycleNo,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      outcome: a.outcome,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
      workerId: a.workerId,
    })),
  };
}
