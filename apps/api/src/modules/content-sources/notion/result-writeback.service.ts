import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../../infra/db/client.js';
import { contentSource, post, publication, type Publication } from '../../../infra/db/schema.js';
import type { Logger } from '../../../infra/logger.js';
import type { Clock } from '../../../shared/clock.js';
import { formatLocal } from '../../scheduling/schedule-time.js';
import { systemContext } from '../../tenancy/tenant-context.js';
import type { ContentSourceService } from '../content-source.service.js';
import { NotionApiError, NotionClient } from './notion-client.js';
import { mapPage, type PropertyMap } from './notion-mapper.js';
import { POSTELYO_STATUS, writebackPatch, type DesiredWriteback } from './notion-writeback.js';

export interface ResultWritebackDeps {
  db: Db;
  contentSources: ContentSourceService;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export type WritebackOutcome = 'done' | 'skipped' | 'unchanged';

/** Delay above which a publication is reported as "Published late" (P3). */
export const LATE_THRESHOLD_SECONDS = 300;

/**
 * Writes publish results back to the source page (architecture §10.5). Runs as
 * its own retried job; a failure here never changes publication state.
 */
export class ResultWritebackService {
  constructor(private readonly deps: ResultWritebackDeps) {}

  /** Throws NotionApiError on transport problems so the job layer can retry. */
  async writeback(publicationId: string, correlationId: string): Promise<WritebackOutcome> {
    const { db } = this.deps;
    const [pub] = await db
      .select()
      .from(publication)
      .where(eq(publication.id, publicationId))
      .limit(1);
    if (!pub) return 'skipped';
    const [postRow] = await db.select().from(post).where(eq(post.id, pub.postId)).limit(1);
    if (!postRow?.contentSourceId || !postRow.externalId) return this.markDone(pub.id, 'skipped');
    const [source] = await db
      .select()
      .from(contentSource)
      .where(eq(contentSource.id, postRow.contentSourceId))
      .limit(1);
    if (!source || source.kind !== 'notion' || source.disconnectedAt || !source.credentialEnc) {
      return this.markDone(pub.id, 'skipped');
    }

    const desired = desiredFor(pub);
    if (!desired) return this.markDone(pub.id, 'skipped');

    const ctx = systemContext(pub.workspaceId, 'writeback', correlationId);
    const map: PropertyMap = (source.config as { propertyMap?: PropertyMap }).propertyMap ?? {};
    try {
      return await this.deps.contentSources.withToken(ctx, source.id, 'sync', async (token) => {
        const client = new NotionClient(
          token,
          this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
        );
        const page = await client.retrievePage(postRow.externalId!);
        const current = mapPage(page, map).system;
        const patch = writebackPatch(map, current, desired);
        if (patch) await client.updatePageProperties(page.id, patch);
        await this.markDone(pub.id, 'done');
        return patch ? 'done' : 'unchanged';
      });
    } catch (err) {
      await db
        .update(publication)
        .set({
          writebackAttempts: sql`${publication.writebackAttempts} + 1`,
          updatedAt: this.deps.clock.now(),
        })
        .where(eq(publication.id, pub.id));
      if (err instanceof NotionApiError && err.code === 'not_found') {
        // Page deleted after scheduling: nothing to write to.
        await this.markDone(pub.id, 'skipped');
        return 'skipped';
      }
      throw err;
    }
  }

  /** Number of writeback attempts so far, used by the job layer to give up. */
  async attempts(publicationId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ n: publication.writebackAttempts })
      .from(publication)
      .where(eq(publication.id, publicationId))
      .limit(1);
    return row?.n ?? 0;
  }

  /** Called by the job layer after the last retry. */
  async markFailed(publicationId: string): Promise<void> {
    await this.deps.db
      .update(publication)
      .set({ writebackState: 'failed', updatedAt: this.deps.clock.now() })
      .where(eq(publication.id, publicationId));
  }

  private async markDone(
    publicationId: string,
    outcome: WritebackOutcome,
  ): Promise<WritebackOutcome> {
    await this.deps.db
      .update(publication)
      .set({
        writebackState: 'done',
        writebackAttempts: sql`${publication.writebackAttempts} + 1`,
        updatedAt: this.deps.clock.now(),
      })
      .where(eq(publication.id, publicationId));
    return outcome;
  }
}

/** Maps a publication's operational state to the system-owned Notion properties (PRD §4.5, §4.6). */
export function desiredFor(pub: Publication): DesiredWriteback | null {
  switch (pub.state) {
    case 'scheduled':
      // Only the daily-cap deferral is ours to report here; the sync writes the normal "Scheduled for …".
      if (pub.lastErrorCode === 'daily_cap' && pub.deferredUntil && pub.lastErrorMessage) {
        return {
          postelyoStatus: POSTELYO_STATUS.scheduled,
          postelyoNote: pub.lastErrorMessage,
          postelyoId: pub.id,
        };
      }
      return null;
    case 'queued':
    case 'publishing':
      return {
        postelyoStatus: POSTELYO_STATUS.publishing,
        postelyoNote: 'Publishing to LinkedIn…',
        postelyoId: pub.id,
      };
    case 'retry_wait': {
      const at = pub.nextAttemptAt
        ? ` at ${formatLocal(pub.nextAttemptAt, pub.scheduledTz)} (${pub.scheduledTz})`
        : '';
      return {
        postelyoStatus: POSTELYO_STATUS.publishing,
        postelyoNote:
          pub.lastErrorCode === 'rate_limited'
            ? `LinkedIn's posting limit was reached; publishing resumes automatically${at}.`
            : `Temporary problem publishing (attempt ${pub.attemptNo} of ${pub.maxAttempts}); retrying automatically${at}.`,
        postelyoId: pub.id,
      };
    }
    case 'published': {
      const late = (pub.delaySeconds ?? 0) > LATE_THRESHOLD_SECONDS;
      const publishedAt = pub.publishedAt ?? new Date();
      const publishedLocal = formatLocal(publishedAt, pub.scheduledTz);
      const note = late
        ? `Scheduled ${pub.scheduledLocal}, published ${publishedLocal} (${Math.round((pub.delaySeconds ?? 0) / 60)} min late, ${pub.scheduledTz}).`
        : `Published ${publishedLocal} (${pub.scheduledTz}).`;
      return {
        postelyoStatus: late ? POSTELYO_STATUS.publishedLate : POSTELYO_STATUS.published,
        postelyoNote: note,
        postelyoId: pub.id,
        publishedUrl: pub.providerPostUrl ?? null,
        publishedAt: publishedAt.toISOString(),
      };
    }
    case 'failed':
      return {
        postelyoStatus: POSTELYO_STATUS.failed,
        postelyoNote: `Publishing failed: ${pub.lastErrorMessage ?? pub.lastErrorCode ?? 'unknown error'} Fix the content or connection, then set Status to Scheduled to retry.`,
        postelyoId: pub.id,
      };
    case 'ambiguous':
      return {
        postelyoStatus: POSTELYO_STATUS.needsReview,
        postelyoNote:
          'LinkedIn did not confirm whether this post was published. Postelyo will not retry automatically to avoid a duplicate; it checks the account for the post a few times and otherwise an operator will review it.',
        postelyoId: pub.id,
      };
    default:
      return null;
  }
}
