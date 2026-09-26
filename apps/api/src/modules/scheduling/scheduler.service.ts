import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { publication, socialAccount, workspace } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { recomputePostState } from '../posts/post-state.js';
import { assertPublicationTransition } from '../posts/state-machine.js';
import type { JobEnqueuer } from '../publishing/jobs.js';
import { systemContext } from '../tenancy/tenant-context.js';
import { dailyCapFor } from '../workspaces/settings.js';
import { accountUsage } from './daily-cap.js';

export interface TickSummary {
  skipped: boolean;
  dispatched: number;
  deferred: number;
  requeued: number;
  leasesExpired: number;
  maxLagSeconds: number;
}

export interface SchedulerDeps {
  db: Db;
  enqueue: JobEnqueuer;
  clock: Clock;
  logger: Logger;
  /** Publications queued longer than this without progress are re-sent (idempotent). */
  staleQueuedMs?: number;
  batchSize?: number;
}

/** Fixed advisory lock key for the tick; only one instance ticks at a time (architecture §8.2). */
const TICK_LOCK_KEY = 7_420_001;
const DEFAULT_STALE_QUEUED_MS = 2 * 60_000;
/** When the cap is hit but nothing in the window will free a slot soon, re-check after this long. */
const CAP_RECHECK_MS = 15 * 60_000;

/**
 * Scheduler tick (architecture §8.2): the database is the schedule of record;
 * jobs are only a delivery mechanism, created at due time. The same tick runs
 * the two sweepers: stale `queued` rows are re-sent (a crash between the state
 * change and the enqueue) and expired leases become `ambiguous`, never `queued`,
 * because the provider call may have succeeded.
 *
 * Phase 1: due rows are checked against the workspace's per-account daily cap
 * before dispatch; rows over the cap stay `scheduled` with `deferred_until`
 * set and a note the writeback shows in Notion.
 */
export class SchedulerService {
  constructor(private readonly deps: SchedulerDeps) {}

  async tick(correlationId: string): Promise<TickSummary> {
    const { db } = this.deps;
    const now = this.deps.clock.now();
    const staleBefore = new Date(
      now.getTime() - (this.deps.staleQueuedMs ?? DEFAULT_STALE_QUEUED_MS),
    );
    const batch = this.deps.batchSize ?? 100;

    const plan = await db.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${TICK_LOCK_KEY}) as locked`,
      );
      const locked = [...lock][0]?.locked === true;
      if (!locked) return null;

      const due = await tx
        .select()
        .from(publication)
        .where(
          and(
            eq(publication.state, 'scheduled'),
            lte(publication.scheduledAt, now),
            or(isNull(publication.deferredUntil), lte(publication.deferredUntil, now)),
          ),
        )
        .orderBy(asc(publication.scheduledAt))
        .limit(batch)
        .for('update', { skipLocked: true });

      let maxLag = 0;
      const dispatched: { publicationId: string; cycleNo: number }[] = [];
      const deferred: string[] = [];
      // Cap bookkeeping per account within this tick, so a burst is counted as it is dispatched.
      const capState = new Map<string, { cap: number; used: number; nextFreeAt: Date | null }>();
      for (const p of due) {
        const ctx = systemContext(p.workspaceId, 'scheduler', correlationId);
        let cs = capState.get(p.socialAccountId);
        if (!cs) {
          const [ws] = await tx
            .select({ settings: workspace.settings })
            .from(workspace)
            .where(eq(workspace.id, p.workspaceId))
            .limit(1);
          const usage = await accountUsage(tx, p.socialAccountId, now);
          cs = { cap: dailyCapFor({ settings: ws?.settings ?? {} }), ...usage };
          capState.set(p.socialAccountId, cs);
        }
        if (cs.used >= cs.cap) {
          const until = cs.nextFreeAt ?? new Date(now.getTime() + CAP_RECHECK_MS);
          const [acc] = await tx
            .select({ name: socialAccount.displayName })
            .from(socialAccount)
            .where(eq(socialAccount.id, p.socialAccountId))
            .limit(1);
          const message = `Deferred: the daily limit of ${cs.cap} posts for ${acc?.name ?? 'this account'} was reached; publishing resumes after ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
          await tx
            .update(publication)
            .set({
              deferredUntil: until,
              lastErrorCode: 'daily_cap',
              lastErrorMessage: message,
              writebackState: 'pending',
              updatedAt: now,
            })
            .where(eq(publication.id, p.id));
          await recordAudit(tx, {
            workspaceId: p.workspaceId,
            actor: ctx.actor,
            entityType: 'publication',
            entityId: p.id,
            event: 'publication.deferred',
            fromState: 'scheduled',
            toState: 'scheduled',
            correlationId,
            data: { reason: 'daily_cap', cap: cs.cap, used: cs.used, until: until.toISOString() },
          });
          deferred.push(p.id);
          continue;
        }
        cs.used += 1;

        assertPublicationTransition('scheduled', 'queued');
        await tx
          .update(publication)
          .set({
            state: 'queued',
            queuedAt: now,
            deferredUntil: null,
            ...(p.lastErrorCode === 'daily_cap'
              ? { lastErrorCode: null, lastErrorMessage: null }
              : {}),
            updatedAt: now,
          })
          .where(eq(publication.id, p.id));
        const lag = Math.max(0, Math.floor((now.getTime() - p.scheduledAt.getTime()) / 1000));
        maxLag = Math.max(maxLag, lag);
        await recordAudit(tx, {
          workspaceId: p.workspaceId,
          actor: ctx.actor,
          entityType: 'publication',
          entityId: p.id,
          event: 'publication.state_changed',
          fromState: 'scheduled',
          toState: 'queued',
          correlationId,
          data: { scheduledAt: p.scheduledAt.toISOString(), lagSeconds: lag, cycleNo: p.cycleNo },
        });
        await recomputePostState(tx, ctx, p.postId);
        dispatched.push({ publicationId: p.id, cycleNo: p.cycleNo });
      }

      const stale = await tx
        .select({
          id: publication.id,
          cycleNo: publication.cycleNo,
          workspaceId: publication.workspaceId,
        })
        .from(publication)
        .where(and(eq(publication.state, 'queued'), lt(publication.queuedAt, staleBefore)))
        .limit(batch);

      const expired = await tx
        .select()
        .from(publication)
        .where(and(eq(publication.state, 'publishing'), lt(publication.leaseExpiresAt, now)))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const p of expired) {
        assertPublicationTransition('publishing', 'ambiguous');
        await tx
          .update(publication)
          .set({
            state: 'ambiguous',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: 'ambiguous',
            lastErrorMessage: `Worker lease expired (owner ${p.leaseOwner ?? 'unknown'}); provider outcome unknown.`,
            writebackState: 'pending',
            updatedAt: now,
          })
          .where(eq(publication.id, p.id));
        const ctx = systemContext(p.workspaceId, 'scheduler', correlationId);
        await recordAudit(tx, {
          workspaceId: p.workspaceId,
          actor: ctx.actor,
          entityType: 'publication',
          entityId: p.id,
          event: 'publication.state_changed',
          fromState: 'publishing',
          toState: 'ambiguous',
          correlationId,
          data: { reason: 'lease_expired', leaseOwner: p.leaseOwner, attemptNo: p.attemptNo },
        });
        await recomputePostState(tx, ctx, p.postId);
        this.deps.logger.error(
          { publicationId: p.id, workspaceId: p.workspaceId, leaseOwner: p.leaseOwner },
          'ALERT publication lease expired: marked ambiguous, manual review required',
        );
      }

      return {
        due: dispatched,
        deferred,
        stale: stale.map((p) => ({ publicationId: p.id, cycleNo: p.cycleNo })),
        expired: expired.map((p) => p.id),
        maxLag,
      };
    });

    if (!plan) {
      return {
        skipped: true,
        dispatched: 0,
        deferred: 0,
        requeued: 0,
        leasesExpired: 0,
        maxLagSeconds: 0,
      };
    }

    // Enqueue after commit so a job never observes a not-yet-committed `queued` row.
    for (const d of plan.due) await this.deps.enqueue.publish(d);
    for (const s of plan.stale) await this.deps.enqueue.publish(s);
    for (const id of plan.expired) await this.deps.enqueue.writeback({ publicationId: id });
    for (const id of plan.deferred) await this.deps.enqueue.writeback({ publicationId: id });

    if (
      plan.due.length > 0 ||
      plan.stale.length > 0 ||
      plan.expired.length > 0 ||
      plan.deferred.length > 0
    ) {
      this.deps.logger.info(
        {
          dispatched: plan.due.length,
          deferred: plan.deferred.length,
          requeued: plan.stale.length,
          leasesExpired: plan.expired.length,
          maxLagSeconds: plan.maxLag,
        },
        'scheduler tick',
      );
    }
    return {
      skipped: false,
      dispatched: plan.due.length,
      deferred: plan.deferred.length,
      requeued: plan.stale.length,
      leasesExpired: plan.expired.length,
      maxLagSeconds: plan.maxLag,
    };
  }
}
