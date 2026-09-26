import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../../infra/db/client.js';
import {
  contentSource,
  post,
  publication,
  socialAccount,
  type Publication,
} from '../../../infra/db/schema.js';
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

    // Several publications share one page (Phase 2): the writeback describes all of them.
    const siblings = await db
      .select({ pub: publication, accountName: socialAccount.displayName })
      .from(publication)
      .leftJoin(socialAccount, eq(socialAccount.id, publication.socialAccountId))
      .where(eq(publication.postId, pub.postId))
      .orderBy(publication.createdAt);
    const desired =
      siblings.length > 1
        ? desiredForPost(siblings.map((s) => ({ ...s.pub, accountName: s.accountName })))
        : desiredFor(pub);
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

// ---------------------------------------------------------------------------
// Post-level aggregation (Phase 2): several publications share one Notion page.
// ---------------------------------------------------------------------------

type PubWithAccount = Publication & { accountName: string | null };

const PROVIDER_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  fake: 'Fake',
};

export function publicationLabel(
  p: Pick<Publication, 'provider'> & { accountName: string | null },
) {
  const provider = PROVIDER_LABEL[p.provider] ?? p.provider;
  return p.accountName ? `${provider} (${p.accountName})` : provider;
}

/** One line per publication for the note. */
function lineFor(p: PubWithAccount): string {
  const at = (d: Date | null) => (d ? `${formatLocal(d, p.scheduledTz)} (${p.scheduledTz})` : '');
  switch (p.state) {
    case 'published':
      return `${publicationLabel(p)}: published ${at(p.publishedAt)}${(p.delaySeconds ?? 0) > LATE_THRESHOLD_SECONDS ? `, ${Math.round((p.delaySeconds ?? 0) / 60)} min late` : ''}.`;
    case 'failed':
      return `${publicationLabel(p)}: failed: ${p.lastErrorMessage ?? p.lastErrorCode ?? 'unknown error'}`;
    case 'ambiguous':
      return `${publicationLabel(p)}: needs review (the provider did not confirm the post).`;
    case 'retry_wait':
      return `${publicationLabel(p)}: ${p.lastErrorCode === 'rate_limited' ? 'waiting for the posting limit' : 'temporary problem, retrying'}${p.nextAttemptAt ? ` at ${at(p.nextAttemptAt)}` : ''}.`;
    case 'queued':
    case 'publishing':
      return `${publicationLabel(p)}: publishing…`;
    case 'blocked':
      return `${publicationLabel(p)}: waiting for re-authorization.`;
    case 'scheduled':
      return `${publicationLabel(p)}: ${p.lastErrorCode === 'daily_cap' && p.lastErrorMessage ? p.lastErrorMessage : `scheduled for ${p.scheduledLocal} (${p.scheduledTz})`}`;
    case 'cancelled':
      return `${publicationLabel(p)}: cancelled.`;
    default:
      return `${publicationLabel(p)}: ${p.state}.`;
  }
}

/**
 * Aggregated status for a page with several targets: any in flight → Publishing;
 * any ambiguous → Needs review; all done and all published → Published (late if any was);
 * published + failed → Partially failed; all failed → Failed; otherwise the
 * pre-publish states are the sync's business (null).
 */
export function desiredForPost(pubs: PubWithAccount[]): DesiredWriteback | null {
  const live = pubs.filter((p) => p.state !== 'cancelled');
  if (live.length === 0) return null;
  const states = new Set(live.map((p) => p.state));
  const inFlight = ['queued', 'publishing', 'retry_wait'].some((s) =>
    states.has(s as Publication['state']),
  );
  const published = live.filter((p) => p.state === 'published');
  const failed = live.filter((p) => p.state === 'failed');
  const waiting = live.filter(
    (p) => p.state === 'scheduled' || p.state === 'blocked' || p.state === 'pending',
  );
  const deferred = waiting.some((p) => p.lastErrorCode === 'daily_cap' && p.deferredUntil);
  let status: DesiredWriteback['postelyoStatus'];
  if (states.has('ambiguous')) status = POSTELYO_STATUS.needsReview;
  else if (inFlight) status = POSTELYO_STATUS.publishing;
  else if (waiting.length > 0 && published.length === 0 && failed.length === 0) {
    if (!deferred) return null;
    status = POSTELYO_STATUS.scheduled;
  } else if (waiting.length > 0) status = POSTELYO_STATUS.publishing;
  else if (failed.length === live.length) status = POSTELYO_STATUS.failed;
  else if (failed.length > 0) status = POSTELYO_STATUS.partiallyFailed;
  else
    status = published.some((p) => (p.delaySeconds ?? 0) > LATE_THRESHOLD_SECONDS)
      ? POSTELYO_STATUS.publishedLate
      : POSTELYO_STATUS.published;

  const note = live.map(lineFor).join('\n');
  const first = published
    .slice()
    .sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0))[0];
  const done = waiting.length === 0 && !inFlight;
  return {
    postelyoStatus: status,
    postelyoNote: note,
    postelyoId: live.map((p) => p.id).join(','),
    ...(done
      ? {
          publishedUrl: published.find((p) => p.providerPostUrl)?.providerPostUrl ?? null,
          publishedAt: first?.publishedAt ? first.publishedAt.toISOString() : null,
          publishedUrls: published
            .filter((p) => p.providerPostUrl)
            .map((p) => ({ label: publicationLabel(p), url: p.providerPostUrl! })),
        }
      : {}),
  };
}
