import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  mediaAsset,
  post,
  publication,
  type ContentSource,
  type MediaAsset,
  type Post,
  type Publication,
  type SocialAccount,
  type Workspace,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { NotionBlock } from '../content-sources/notion/notion-client.js';
import { MediaError } from '../media/media-fetcher.js';
import { enrichRenderedMedia, type MediaService } from '../media/media.service.js';
import { buildCanonicalContent, type SourcePost } from '../content-sources/notion/notion-mapper.js';
import {
  POSTELYO_STATUS,
  clearedWriteback,
  type DesiredWriteback,
} from '../content-sources/notion/notion-writeback.js';
import { accountRef, providerIdOf } from '../publishing/engine.js';
import type { AccountType } from '../publishing/provider.js';
import type { ProviderRegistry } from '../publishing/registry.js';
import { providerEnabled } from '../workspaces/settings.js';
import { resolveSchedule } from '../scheduling/schedule-time.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { CanonicalContent, PostSnapshot } from './content.js';
import {
  PUBLICATION_WAITING,
  assertPublicationTransition,
  derivePostState,
  editorialStateFromSourceStatus,
  type PostState,
  type PublicationState,
} from './state-machine.js';

type SocialProvider = SocialAccount['provider'];

/**
 * Notion `Platforms` option → provider + account type. With several accounts
 * of that kind connected, the option `<Platform>: <account name>` picks one
 * (e.g. `LinkedIn Page: Acme`, `X: @alice`, `Instagram: @acme`).
 */
const PLATFORM_TO_TARGET: Record<string, { provider: SocialProvider; accountType: AccountType }> = {
  linkedin: { provider: 'linkedin', accountType: 'member' },
  'linkedin page': { provider: 'linkedin', accountType: 'organization' },
  x: { provider: 'x', accountType: 'member' },
  twitter: { provider: 'x', accountType: 'member' },
  facebook: { provider: 'facebook', accountType: 'page' },
  'facebook page': { provider: 'facebook', accountType: 'page' },
  instagram: { provider: 'instagram', accountType: 'business' },
};

/** A date this far in the past is still accepted and published immediately (PRD §4.5). */
const PAST_GRACE_MS = 10 * 60 * 1000;
/** Content edits closer than this to the scheduled time are not re-snapshotted (PRD §4.5). */
const SNAPSHOT_FREEZE_MS = 5 * 60 * 1000;

export interface ValidationIssue {
  code: string;
  message: string;
  target?: string;
}

export type IngestAction =
  'archived' | 'mirrored' | 'awaiting_schedule' | 'validation_error' | 'scheduled' | 'cancelled';

export interface IngestResult {
  postId: string;
  action: IngestAction;
  writeback: DesiredWriteback | null;
}

export interface IngestInput {
  ctx: TenantContext;
  source: Pick<ContentSource, 'id'>;
  workspace: Pick<Workspace, 'id' | 'defaultTimezone' | 'defaultPublishTime' | 'settings'>;
  page: SourcePost;
  /** Lazily loads the page body; only called when a snapshot is (re)taken. */
  loadBody: () => Promise<NotionBlock[]>;
  /** Workspace social accounts that are not disconnected. */
  accounts: SocialAccount[];
}

export interface PostIngestDeps {
  db: Db;
  providers: ProviderRegistry;
  media: MediaService;
  clock: Clock;
  logger: Logger;
  /** Phase 3 plan limit: resolves to a reason when the workspace may not schedule more posts this month. */
  postLimit?: (workspaceId: string) => Promise<string | null>;
}

/**
 * Applies one observed source page to our Post/Publication records
 * (architecture §7.3). Editorial status is mirrored, never enforced (P6);
 * `Ready` never enqueues (P8); `Scheduled` validates, snapshots and creates
 * or reschedules publications.
 */
export class PostIngestService {
  constructor(private readonly deps: PostIngestDeps) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const { ctx, page } = input;
    const db = this.deps.db;
    const now = this.deps.clock.now();

    const existing = await this.findPost(input.source.id, page.externalId);

    if (page.archived) {
      return this.archive(input, existing);
    }

    const editorial = editorialStateFromSourceStatus(page.sourceStatus);
    const postRow = await this.upsertBase(input, existing, editorial);
    const pubs = existing ? await this.loadPublications(postRow.id) : [];

    if (editorial !== 'scheduled') {
      return this.mirror(input, postRow, pubs, editorial);
    }

    // --- Scheduled: validate ------------------------------------------------
    const issues: ValidationIssue[] = [];
    const warnings: string[] = [];

    const targets = resolveTargets(page.platforms, input.accounts, issues, (provider) =>
      providerEnabled(input.workspace, provider),
    );
    // Plan limit (Phase 3): only new scheduling is refused; already-waiting rows keep their slot.
    if (this.deps.postLimit && !pubs.some((p) => PUBLICATION_WAITING.includes(p.state))) {
      const reason = await this.deps.postLimit(ctx.workspaceId);
      if (reason) issues.push({ code: 'PLAN_LIMIT', message: reason });
    }

    let schedule: ReturnType<typeof resolveSchedule> | null = null;
    if (!page.publishDate) {
      issues.push({ code: 'DATE_MISSING', message: 'Publish Date is empty.' });
    } else {
      schedule = resolveSchedule({
        date: page.publishDate,
        postTimeZone: page.timeZone,
        workspaceTimeZone: input.workspace.defaultTimezone,
        defaultPublishTime: input.workspace.defaultPublishTime,
      });
      if (!schedule.ok) issues.push({ code: schedule.error.code, message: schedule.error.message });
      else warnings.push(...schedule.value.warnings);
    }

    const waiting = pubs.filter((p) => PUBLICATION_WAITING.includes(p.state));
    if (schedule?.ok) {
      const at = schedule.value.scheduledAt.getTime();
      const unchanged = waiting.some((p) => p.scheduledAt.getTime() === at);
      if (!unchanged && at < now.getTime() - PAST_GRACE_MS) {
        issues.push({
          code: 'DATE_IN_PAST',
          message: `Publish Date ${schedule.value.local} (${schedule.value.timeZone}) is in the past.`,
        });
      }
    }

    // Snapshot: reload the body when the page changed since the last snapshot.
    const needsSnapshot =
      !existing ||
      existing.contentHash === '' ||
      existing.sourceEditedAt?.toISOString() !== page.lastEditedTime;
    let content: CanonicalContent = existing?.content as CanonicalContent;
    let contentHash = existing?.contentHash ?? '';
    let snapshotChanged = false;
    if (needsSnapshot || issues.length === 0) {
      const body = await input.loadBody();
      const media = await this.syncMediaAssets(input, postRow.id, page);
      const mapped = buildCanonicalContent({
        page,
        bodyBlocks: body,
        mediaAssetIds: media.rows.map((r) => r.id),
      });
      warnings.push(...mapped.warnings);
      if (mapped.hash !== contentHash) {
        snapshotChanged = true;
        content = mapped.content;
        contentHash = mapped.hash;
      }
      // Inspect new or changed files now so bad images surface before publish time (PRD §4.7).
      for (const row of media.rows) {
        if (row.contentHash && !media.changed.has(row.id) && !row.lastError) continue;
        try {
          await this.deps.media.inspect(row);
        } catch (err) {
          const message = err instanceof MediaError ? err.message : 'could not read the file';
          issues.push({ code: 'MEDIA_INVALID', message: `Image "${row.name}": ${message}` });
        }
      }
    }

    if (content && issues.length === 0) {
      const snapshot: PostSnapshot = {
        postId: postRow.id,
        workspaceId: ctx.workspaceId,
        title: page.title,
        content,
        contentHash,
      };
      const mediaRows = await this.deps.media.rowsFor(content.media.map((m) => m.assetId));
      for (const t of targets) {
        const provider = this.deps.providers.get(providerIdOf(t.provider));
        const ref = accountRef(t.account);
        const rendered = enrichRenderedMedia(provider.render(snapshot, ref), mediaRows, t.provider);
        const validation = provider.validate(rendered, ref);
        if (!validation.ok) {
          issues.push(...validation.issues.map((i) => ({ ...i, target: t.provider })));
        }
      }
    }

    if (issues.length > 0 || !schedule?.ok) {
      return this.validationFailed(input, postRow, pubs, issues, warnings);
    }

    // --- Scheduled: apply ---------------------------------------------------
    const sched = schedule.value;
    const freezeSnapshot =
      snapshotChanged &&
      existing !== null &&
      existing.contentHash !== '' &&
      waiting.length > 0 &&
      waiting.some((p) => p.scheduledAt.getTime() - now.getTime() < SNAPSHOT_FREEZE_MS);
    const inFlightOrDone = pubs.filter(
      (p) =>
        !PUBLICATION_WAITING.includes(p.state) && p.state !== 'failed' && p.state !== 'cancelled',
    );
    if (snapshotChanged && inFlightOrDone.length > 0 && waiting.length === 0) {
      warnings.push('Content changed after publishing started; the earlier version is used.');
      content = existing!.content as CanonicalContent;
      contentHash = existing!.contentHash;
    } else if (freezeSnapshot) {
      warnings.push(
        'Content changed less than 5 minutes before the scheduled time; the earlier version will be published.',
      );
      content = existing.content as CanonicalContent;
      contentHash = existing.contentHash;
    }

    // A terminal publication (failed/cancelled) is only re-scheduled when the user
    // changed something: status left and came back, content edited, or date moved.
    // Our own writeback edits the page too, so "page edited" alone is not intent.
    const statusChanged =
      !existing || (existing.sourceStatus ?? null) !== (page.sourceStatus ?? null);
    const retryIntentFor = (p: Publication): boolean =>
      statusChanged || snapshotChanged || p.scheduledAt.getTime() !== sched.scheduledAt.getTime();

    const result = await db.transaction(async (tx) => {
      let cycleNo = postRow.cycleNo;
      const needsNewCycle = targets.some((t) => {
        const p = pubs.find((x) => x.socialAccountId === t.account.id);
        return p && (p.state === 'failed' || p.state === 'cancelled') && retryIntentFor(p);
      });
      if (needsNewCycle) cycleNo += 1;

      const pubIds: string[] = [];
      let anyBlocked = false;
      let anyWaiting = false;
      let touched = false;
      const pubStates: PublicationState[] = [];

      for (const t of targets) {
        const desiredState: PublicationState =
          t.account.status === 'active' ? 'scheduled' : 'blocked';
        const current = pubs.find((x) => x.socialAccountId === t.account.id);

        if (!current) {
          if (desiredState === 'blocked') anyBlocked = true;
          anyWaiting = true;
          touched = true;
          const id = uuidv7();
          await tx.insert(publication).values({
            id,
            workspaceId: ctx.workspaceId,
            postId: postRow.id,
            socialAccountId: t.account.id,
            provider: t.provider,
            state: desiredState,
            scheduledAt: sched.scheduledAt,
            scheduledTz: sched.timeZone,
            scheduledLocal: sched.local,
            cycleNo,
          });
          await recordAudit(tx, {
            workspaceId: ctx.workspaceId,
            actor: ctx.actor,
            entityType: 'publication',
            entityId: id,
            event: 'publication.created',
            toState: desiredState,
            correlationId: ctx.correlationId,
            data: {
              postId: postRow.id,
              provider: t.provider,
              scheduledAt: sched.scheduledAt.toISOString(),
              tz: sched.timeZone,
              local: sched.local,
              cycleNo,
            },
          });
          pubIds.push(id);
          pubStates.push(desiredState);
          continue;
        }

        pubIds.push(current.id);
        if (PUBLICATION_WAITING.includes(current.state)) {
          anyWaiting = true;
          if (desiredState === 'blocked') anyBlocked = true;
          const timeChanged = current.scheduledAt.getTime() !== sched.scheduledAt.getTime();
          const stateChanged = current.state !== desiredState;
          if (timeChanged || stateChanged) {
            touched = true;
            assertPublicationTransition(current.state, desiredState);
            await tx
              .update(publication)
              .set({
                state: desiredState,
                scheduledAt: sched.scheduledAt,
                scheduledTz: sched.timeZone,
                scheduledLocal: sched.local,
                // A moved date re-enters the cap check from scratch.
                ...(timeChanged
                  ? { deferredUntil: null, lastErrorCode: null, lastErrorMessage: null }
                  : {}),
                updatedAt: now,
              })
              .where(eq(publication.id, current.id));
            await recordAudit(tx, {
              workspaceId: ctx.workspaceId,
              actor: ctx.actor,
              entityType: 'publication',
              entityId: current.id,
              event: timeChanged ? 'publication.rescheduled' : 'publication.state_changed',
              fromState: current.state,
              toState: desiredState,
              correlationId: ctx.correlationId,
              data: {
                from: current.scheduledAt.toISOString(),
                to: sched.scheduledAt.toISOString(),
                local: sched.local,
                tz: sched.timeZone,
              },
            });
          }
          pubStates.push(desiredState);
        } else if (
          (current.state === 'failed' || current.state === 'cancelled') &&
          retryIntentFor(current)
        ) {
          anyWaiting = true;
          touched = true;
          if (desiredState === 'blocked') anyBlocked = true;
          assertPublicationTransition(current.state, desiredState);
          await tx
            .update(publication)
            .set({
              state: desiredState,
              scheduledAt: sched.scheduledAt,
              scheduledTz: sched.timeZone,
              scheduledLocal: sched.local,
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
            .where(eq(publication.id, current.id));
          await recordAudit(tx, {
            workspaceId: ctx.workspaceId,
            actor: ctx.actor,
            entityType: 'publication',
            entityId: current.id,
            event: 'publication.state_changed',
            fromState: current.state,
            toState: desiredState,
            correlationId: ctx.correlationId,
            data: { reason: 'manual_retry', cycleNo, scheduledAt: sched.scheduledAt.toISOString() },
          });
          pubStates.push(desiredState);
        } else {
          // queued / publishing / retry_wait / ambiguous / published, or a terminal
          // row with no retry intent: the engine (or the operator) owns it.
          if (snapshotChanged || statusChanged) {
            warnings.push(
              current.state === 'published'
                ? `Already published to ${t.provider}; not publishing again.`
                : current.state === 'failed'
                  ? `Previous attempt failed; set Status away from Scheduled and back, or edit the post, to retry.`
                  : `Publishing to ${t.provider} is in progress; changes were not applied.`,
            );
          }
          pubStates.push(current.state);
        }
      }

      // Targets removed from the page: cancel their waiting publications.
      for (const p of waiting) {
        if (!targets.some((t) => t.account.id === p.socialAccountId)) {
          await this.cancelPublication(tx, ctx, p, now, 'target_removed');
          pubStates.push('cancelled');
        }
      }

      const nextState = derivePostState(pubStates) ?? 'scheduled';
      const snapshotTaken = contentHash !== (existing?.contentHash ?? '');
      await tx
        .update(post)
        .set({
          state: nextState,
          content,
          contentHash,
          validationErrors: null,
          warnings,
          cycleNo,
          requestedPublishLocal: sched.local,
          requestedTimezone: sched.timeZone,
          updatedAt: now,
        })
        .where(eq(post.id, postRow.id));
      if (snapshotTaken) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: postRow.id,
          event: 'post.snapshot_taken',
          correlationId: ctx.correlationId,
          data: { contentHash, sourceEditedAt: page.lastEditedTime },
        });
      }
      if (nextState !== postRow.state) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: postRow.id,
          event: 'post.state_changed',
          fromState: postRow.state,
          toState: nextState,
          correlationId: ctx.correlationId,
        });
      }
      return { pubIds, anyBlocked, anyWaiting, touched };
    });

    if (!result.anyWaiting) {
      // Everything is published, in flight, or terminal without retry intent:
      // leave the engine's/operator's writeback (Published, Failed, …) in place.
      return { postId: postRow.id, action: 'mirrored', writeback: null };
    }

    // A publication parked by the daily cap keeps its deferral note across syncs so
    // the ingest writeback and the engine writeback never flip-flop.
    const deferred = pubs.find(
      (p) => result.pubIds.includes(p.id) && p.deferredUntil && p.deferredUntil > now,
    );
    const note = [
      result.anyBlocked
        ? 'A connected social account needs re-authorization before this post can be published.'
        : deferred?.lastErrorMessage
          ? deferred.lastErrorMessage
          : `Scheduled for ${sched.local} (${sched.timeZone}).`,
      ...warnings,
    ].join(' ');
    return {
      postId: postRow.id,
      action: 'scheduled',
      writeback: {
        postelyoStatus: result.anyBlocked ? POSTELYO_STATUS.needsReauth : POSTELYO_STATUS.scheduled,
        postelyoNote: note,
        postelyoId: result.pubIds.join(','),
      },
    };
  }

  // ---------------------------------------------------------------------------

  private async findPost(sourceId: string, externalId: string): Promise<Post | null> {
    const [row] = await this.deps.db
      .select()
      .from(post)
      .where(and(eq(post.contentSourceId, sourceId), eq(post.externalId, externalId)))
      .limit(1);
    return row ?? null;
  }

  private async loadPublications(postId: string): Promise<Publication[]> {
    return this.deps.db.select().from(publication).where(eq(publication.postId, postId));
  }

  /** Creates or updates the mirrored, non-operational columns and audits status observations. */
  private async upsertBase(
    input: IngestInput,
    existing: Post | null,
    editorial: PostState,
  ): Promise<Post> {
    const { ctx, page } = input;
    const now = this.deps.clock.now();
    const sourceEditedAt = page.lastEditedTime ? new Date(page.lastEditedTime) : now;
    const base = {
      title: page.title,
      externalUrl: page.externalUrl,
      sourceStatus: page.sourceStatus,
      sourceEditedAt,
      requestedPlatforms: page.platforms,
      requestedPublishLocal: page.publishDate?.start ?? null,
      requestedTimezone: page.publishDate?.timeZone ?? page.timeZone ?? null,
      deletedAt: null,
      updatedAt: now,
    };
    return this.deps.db.transaction(async (tx) => {
      if (!existing) {
        const id = uuidv7();
        const [row] = await tx
          .insert(post)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            contentSourceId: input.source.id,
            externalId: page.externalId,
            state: editorial === 'scheduled' ? 'scheduled' : editorial,
            ...base,
          })
          .returning();
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: id,
          event: 'post.created',
          toState: row!.state,
          correlationId: ctx.correlationId,
          data: { externalId: page.externalId, sourceStatus: page.sourceStatus },
        });
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: id,
          event: 'post.source_status_observed',
          fromState: null,
          toState: page.sourceStatus,
          correlationId: ctx.correlationId,
          data: { source: 'notion' },
        });
        return row!;
      }
      const [row] = await tx.update(post).set(base).where(eq(post.id, existing.id)).returning();
      if ((existing.sourceStatus ?? null) !== (page.sourceStatus ?? null)) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: existing.id,
          event: 'post.source_status_observed',
          fromState: existing.sourceStatus,
          toState: page.sourceStatus,
          correlationId: ctx.correlationId,
          data: { source: 'notion' },
        });
      }
      return row!;
    });
  }

  /** Non-scheduled editorial statuses: cancel waiting publications, mirror the state. */
  private async mirror(
    input: IngestInput,
    postRow: Post,
    pubs: Publication[],
    editorial: PostState,
  ): Promise<IngestResult> {
    const { ctx, page } = input;
    const now = this.deps.clock.now();
    const cancelled = await this.deps.db.transaction(async (tx) => {
      let n = 0;
      for (const p of pubs) {
        if (PUBLICATION_WAITING.includes(p.state) || p.state === 'retry_wait') {
          await this.cancelPublication(
            tx,
            ctx,
            p,
            now,
            editorial === 'cancelled' ? 'source_cancelled' : 'source_unscheduled',
          );
          n += 1;
        }
      }
      const remaining = pubs.map((p) =>
        PUBLICATION_WAITING.includes(p.state) || p.state === 'retry_wait'
          ? ('cancelled' as const)
          : p.state,
      );
      const derived = derivePostState(remaining);
      const operational = derived && !['scheduled', 'cancelled'].includes(derived);
      const nextState: PostState = operational ? derived : editorial;
      await tx
        .update(post)
        .set({ state: nextState, validationErrors: null, warnings: [], updatedAt: now })
        .where(eq(post.id, postRow.id));
      if (nextState !== postRow.state) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'post',
          entityId: postRow.id,
          event: 'post.state_changed',
          fromState: postRow.state,
          toState: nextState,
          correlationId: ctx.correlationId,
          data: { reason: 'source_status', sourceStatus: page.sourceStatus },
        });
      }
      return n;
    });

    if (editorial === 'ready' && page.publishDate) {
      return {
        postId: postRow.id,
        action: 'awaiting_schedule',
        writeback: {
          postelyoStatus: POSTELYO_STATUS.awaitingSchedule,
          postelyoNote: '',
          postelyoId: '',
        },
      };
    }
    return {
      postId: postRow.id,
      action: cancelled > 0 || editorial === 'cancelled' ? 'cancelled' : 'mirrored',
      writeback: clearedWriteback(page.system),
    };
  }

  private async validationFailed(
    input: IngestInput,
    postRow: Post,
    pubs: Publication[],
    issues: ValidationIssue[],
    warnings: string[],
  ): Promise<IngestResult> {
    const { ctx } = input;
    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      for (const p of pubs) {
        if (PUBLICATION_WAITING.includes(p.state))
          await this.cancelPublication(tx, ctx, p, now, 'validation_failed');
      }
      await tx
        .update(post)
        .set({ state: 'scheduled', validationErrors: issues, warnings, updatedAt: now })
        .where(eq(post.id, postRow.id));
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'post',
        entityId: postRow.id,
        event: 'post.validation_failed',
        correlationId: ctx.correlationId,
        data: { issues: issues.map((i) => i.code) },
      });
    });
    return {
      postId: postRow.id,
      action: 'validation_error',
      writeback: {
        postelyoStatus: POSTELYO_STATUS.validationError,
        postelyoNote: issues.map((i) => i.message).join(' '),
        postelyoId: '',
      },
    };
  }

  private async archive(input: IngestInput, existing: Post | null): Promise<IngestResult> {
    const { ctx } = input;
    const now = this.deps.clock.now();
    if (!existing) return { postId: '', action: 'archived', writeback: null };
    const pubs = await this.loadPublications(existing.id);
    await this.deps.db.transaction(async (tx) => {
      for (const p of pubs) {
        if (PUBLICATION_WAITING.includes(p.state) || p.state === 'retry_wait') {
          await this.cancelPublication(tx, ctx, p, now, 'source_archived');
        }
      }
      const derived = derivePostState(
        pubs.map((p) => (PUBLICATION_WAITING.includes(p.state) ? 'cancelled' : p.state)),
      );
      const nextState: PostState = derived && derived !== 'scheduled' ? derived : 'cancelled';
      await tx
        .update(post)
        .set({ deletedAt: now, state: nextState, updatedAt: now })
        .where(eq(post.id, existing.id));
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'post',
        entityId: existing.id,
        event: 'post.archived',
        fromState: existing.state,
        toState: nextState,
        correlationId: ctx.correlationId,
      });
    });
    return { postId: existing.id, action: 'archived', writeback: null };
  }

  private async cancelPublication(
    tx: Pick<Db, 'update' | 'insert'>,
    ctx: TenantContext,
    p: Publication,
    now: Date,
    reason: string,
  ): Promise<void> {
    assertPublicationTransition(p.state, 'cancelled');
    await tx
      .update(publication)
      .set({ state: 'cancelled', updatedAt: now })
      .where(eq(publication.id, p.id));
    await recordAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'publication',
      entityId: p.id,
      event: 'publication.state_changed',
      fromState: p.state,
      toState: 'cancelled',
      correlationId: ctx.correlationId,
      data: { reason },
    });
  }

  /**
   * Upserts media_asset rows for the page's files; returns rows in page order plus
   * the ids whose source URL path changed (a different file under the same name).
   * Notion signs file URLs with a changing query string, so identity is the path.
   */
  private async syncMediaAssets(
    input: IngestInput,
    postId: string,
    page: SourcePost,
  ): Promise<{ rows: MediaAsset[]; changed: Set<string> }> {
    const db = this.deps.db;
    const existing = await db.select().from(mediaAsset).where(eq(mediaAsset.postId, postId));
    const keyOf = (url: string) => url.split('?')[0] ?? url;
    const rows: MediaAsset[] = [];
    const changed = new Set<string>();
    const keep = new Set<string>();
    for (const m of page.media) {
      const found =
        existing.find((e) => keyOf(e.sourceUrl) === keyOf(m.url)) ??
        existing.find((e) => e.name === m.name && !keep.has(e.id));
      if (found) {
        const pathChanged = keyOf(found.sourceUrl) !== keyOf(m.url);
        if (found.sourceUrl !== m.url || found.name !== m.name) {
          const [updated] = await db
            .update(mediaAsset)
            .set({ sourceUrl: m.url, name: m.name, updatedAt: this.deps.clock.now() })
            .where(eq(mediaAsset.id, found.id))
            .returning();
          rows.push(updated!);
        } else {
          rows.push(found);
        }
        if (pathChanged) changed.add(found.id);
        keep.add(found.id);
        continue;
      }
      const id = uuidv7();
      const [inserted] = await db
        .insert(mediaAsset)
        .values({
          id,
          workspaceId: input.ctx.workspaceId,
          postId,
          sourceUrl: m.url,
          sourceKind: m.kind,
          name: m.name,
          mimeType: guessMime(m.name),
        })
        .returning();
      rows.push(inserted!);
      changed.add(id);
      keep.add(id);
    }
    const stale = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (stale.length > 0) await db.delete(mediaAsset).where(inArray(mediaAsset.id, stale));
    return { rows, changed };
  }
}

interface Target {
  provider: SocialProvider;
  account: SocialAccount;
}

function resolveTargets(
  platforms: string[],
  accounts: SocialAccount[],
  issues: ValidationIssue[],
  enabled: (provider: SocialProvider) => boolean = () => true,
): Target[] {
  const targets: Target[] = [];
  if (platforms.length === 0) {
    issues.push({ code: 'PLATFORMS_MISSING', message: 'Select at least one platform.' });
    return targets;
  }
  for (const platform of platforms) {
    // "LinkedIn Page: Acme" → key "linkedin page", qualifier "Acme".
    const [rawKey = '', ...rest] = platform.split(':');
    const key = rawKey.trim().toLowerCase();
    const qualifier = rest.join(':').trim().toLowerCase();
    const target = PLATFORM_TO_TARGET[key];
    if (!target) {
      issues.push({
        code: 'UNKNOWN_PLATFORM',
        message: `Platform "${platform}" is not supported yet.`,
      });
      continue;
    }
    if (!enabled(target.provider)) {
      issues.push({
        code: 'PLATFORM_DISABLED',
        message: `${rawKey.trim()} is not enabled for this workspace yet. Ask your Postelyo admin to switch it on.`,
        target: target.provider,
      });
      continue;
    }
    const candidates = accounts.filter(
      (a) =>
        a.provider === target.provider &&
        a.accountType === target.accountType &&
        !a.disconnectedAt &&
        (a.status === 'active' || a.status === 'needs_reauth'),
    );
    const matched = qualifier
      ? candidates.filter((a) => a.displayName.trim().toLowerCase() === qualifier)
      : candidates;
    if (matched.length === 0) {
      issues.push({
        code: 'NO_ACCOUNT',
        message: qualifier
          ? `No ${rawKey.trim()} named "${rest.join(':').trim()}" is connected to this workspace. Check the Connections page.`
          : `No ${platform} account is connected to this workspace. Connect one on the Connections page.`,
        target: target.provider,
      });
      continue;
    }
    if (matched.length > 1) {
      issues.push({
        code: 'AMBIGUOUS_ACCOUNT',
        message: `Several ${rawKey.trim()} accounts are connected (${matched.map((a) => a.displayName).join(', ')}). Use the option "${rawKey.trim()}: <name>" to pick one.`,
        target: target.provider,
      });
      continue;
    }
    const account = matched[0]!;
    if (targets.some((t) => t.account.id === account.id)) continue;
    targets.push({ provider: target.provider, account });
  }
  return targets;
}

function guessMime(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    }[ext] ?? null
  );
}
