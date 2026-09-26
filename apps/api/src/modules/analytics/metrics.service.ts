import { and, count, eq, gte, isNull, lt, lte } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  contentSource,
  post,
  publication,
  publicationMetric,
  socialAccount,
  type Publication,
  type PublicationMetric,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { SocialAccountService } from '../connections/social-account.service.js';
import type { ContentSourceService } from '../content-sources/content-source.service.js';
import { NotionClient } from '../content-sources/notion/notion-client.js';
import type { PropertyMap } from '../content-sources/notion/notion-mapper.js';
import { accountRef, providerIdOf } from '../publishing/engine.js';
import type { JobEnqueuer } from '../publishing/jobs.js';
import type { MetricsResult, PostMetrics } from '../publishing/provider.js';
import type { ProviderRegistry } from '../publishing/registry.js';
import { systemContext } from '../tenancy/tenant-context.js';

/**
 * Phase 5 metrics collection. Each published publication is fetched on a
 * decaying schedule (tiers after publish); every fetch stores one snapshot
 * per tier and schedules the next. Fetches run on their own queue so they
 * never compete with publishing, and a per-workspace hourly budget per
 * provider keeps Postelyo well inside platform rate limits.
 */

/** Fetch tiers as milliseconds after `published_at`. */
export const METRIC_TIERS_MS: readonly number[] = [
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];
export const METRIC_TIER_LABELS = ['1h', '6h', '24h', '7d', '30d'] as const;
/** Fetches per workspace per provider per hour. */
export const METRICS_HOURLY_BUDGET = 200;
/** Retryable failures before a publication stops being fetched. */
export const METRICS_MAX_ATTEMPTS = 10;
/** Snapshots older than this are pruned. */
export const METRICS_RETENTION_DAYS = 400;
/** Backfill window for published posts that never got metrics. */
export const METRICS_BACKFILL_DAYS = 30;
const DEFAULT_RETRY_MS = 60 * 60_000;
const MAX_RETRY_MS = 24 * 60 * 60_000;

export interface PostMetricsServiceDeps {
  db: Db;
  providers: ProviderRegistry;
  socialAccounts: SocialAccountService;
  contentSources: ContentSourceService;
  enqueue: JobEnqueuer;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export type FetchOutcome = 'fetched' | 'rescheduled' | 'stopped' | 'skipped' | 'budget';

export class PostMetricsService {
  constructor(private readonly deps: PostMetricsServiceDeps) {}

  /** Whether the provider behind an account reports metrics. */
  supports(provider: Publication['provider']): boolean {
    return this.deps.providers.get(providerIdOf(provider)).capabilities().metrics === true;
  }

  /** Called by the engine right after a successful publish. */
  async scheduleAfterPublish(
    pub: Pick<Publication, 'id' | 'provider' | 'publishedAt'>,
  ): Promise<void> {
    if (!this.supports(pub.provider) || !pub.publishedAt) return;
    const at = new Date(pub.publishedAt.getTime() + METRIC_TIERS_MS[0]!);
    await this.deps.db
      .update(publication)
      .set({
        metricsTier: 0,
        metricsNextAt: at,
        metricsError: null,
        updatedAt: this.deps.clock.now(),
      })
      .where(eq(publication.id, pub.id));
    await this.deps.enqueue.fetchMetrics({ publicationId: pub.id }, { startAfter: at });
  }

  /** Job handler: one fetch for the publication's current tier. */
  async fetch(publicationId: string, correlationId: string): Promise<FetchOutcome> {
    const { db } = this.deps;
    const now = this.deps.clock.now();
    const [pub] = await db
      .select()
      .from(publication)
      .where(eq(publication.id, publicationId))
      .limit(1);
    if (!pub || pub.state !== 'published' || !pub.providerPostId || !pub.publishedAt)
      return 'skipped';
    if (pub.metricsNextAt === null || pub.metricsTier >= METRIC_TIERS_MS.length) return 'skipped';
    if (pub.metricsNextAt.getTime() > now.getTime() + 60_000) {
      // Ran early (manual trigger); wait for the scheduled time.
      await this.deps.enqueue.fetchMetrics({ publicationId }, { startAfter: pub.metricsNextAt });
      return 'rescheduled';
    }
    const [account] = await db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, pub.socialAccountId))
      .limit(1);
    const provider = account ? this.deps.providers.get(providerIdOf(account.provider)) : null;
    if (!account || !provider?.metrics || !provider.capabilities().metrics) {
      await this.stop(pub, 'metrics not supported for this account', correlationId);
      return 'stopped';
    }
    if (account.status !== 'active' || account.disconnectedAt || !account.accessTokenEnc) {
      return this.reschedule(pub, DEFAULT_RETRY_MS, 'account not active', correlationId);
    }
    if (await this.overBudget(pub.workspaceId, pub.provider, now)) {
      await this.deps.db
        .update(publication)
        .set({ metricsNextAt: new Date(now.getTime() + DEFAULT_RETRY_MS), updatedAt: now })
        .where(eq(publication.id, pub.id));
      await this.deps.enqueue.fetchMetrics(
        { publicationId },
        { startAfter: new Date(now.getTime() + DEFAULT_RETRY_MS) },
      );
      return 'budget';
    }

    const ctx = systemContext(pub.workspaceId, 'metrics', correlationId);
    let result: MetricsResult;
    try {
      result = await this.deps.socialAccounts.withAccessToken(
        ctx,
        account.id,
        'publish',
        (accessToken) =>
          provider.metrics!(
            { publicationId, account: accountRef(account), providerPostId: pub.providerPostId! },
            { credentials: { accessToken }, correlationId, timeoutMs: 20_000 },
          ),
      );
    } catch (err) {
      result = {
        kind: 'unavailable',
        reason: `internal error: ${(err as Error).message}`,
        retryable: true,
      };
    }

    if (result.kind === 'unavailable') {
      if (!result.retryable) {
        await this.stop(pub, result.reason, correlationId);
        return 'stopped';
      }
      if (pub.metricsAttempts + 1 >= METRICS_MAX_ATTEMPTS) {
        await this.stop(
          pub,
          `gave up after ${METRICS_MAX_ATTEMPTS} attempts: ${result.reason}`,
          correlationId,
        );
        return 'stopped';
      }
      return this.reschedule(
        pub,
        Math.min(result.retryAfterMs ?? DEFAULT_RETRY_MS, MAX_RETRY_MS),
        result.reason,
        correlationId,
      );
    }

    const tier = pub.metricsTier;
    await this.record(pub, tier, result.metrics, result.raw, now);
    const nextTier = tier + 1;
    const nextAt =
      nextTier < METRIC_TIERS_MS.length
        ? new Date(
            Math.max(
              now.getTime() + 60_000,
              pub.publishedAt.getTime() + METRIC_TIERS_MS[nextTier]!,
            ),
          )
        : null;
    await db
      .update(publication)
      .set({
        metricsTier: nextTier,
        metricsNextAt: nextAt,
        metricsFetchedAt: now,
        metricsAttempts: 0,
        metricsError: null,
        updatedAt: now,
      })
      .where(eq(publication.id, pub.id));
    if (nextAt) await this.deps.enqueue.fetchMetrics({ publicationId }, { startAfter: nextAt });
    await recordAudit(db, {
      workspaceId: pub.workspaceId,
      actor: ctx.actor,
      entityType: 'publication',
      entityId: pub.id,
      event: 'metrics.fetched',
      correlationId,
      data: { tier: METRIC_TIER_LABELS[tier], ...result.metrics },
    });
    await this.writePostColumns(pub, result.metrics, now).catch((err: unknown) => {
      this.deps.logger.warn({ err, publicationId }, 'metrics writeback to Notion failed');
    });
    return 'fetched';
  }

  private async record(
    pub: Publication,
    tier: number,
    metrics: PostMetrics,
    raw: unknown,
    now: Date,
  ): Promise<void> {
    const values = {
      workspaceId: pub.workspaceId,
      publicationId: pub.id,
      provider: pub.provider,
      tier,
      fetchedAt: now,
      ...metrics,
      raw: truncate(raw),
    };
    await this.deps.db
      .insert(publicationMetric)
      .values({ id: uuidv7(), ...values })
      .onConflictDoUpdate({
        target: [publicationMetric.publicationId, publicationMetric.tier],
        set: { ...values },
      });
  }

  private async reschedule(
    pub: Publication,
    delayMs: number,
    reason: string,
    correlationId: string,
  ): Promise<FetchOutcome> {
    const now = this.deps.clock.now();
    const at = new Date(now.getTime() + delayMs);
    await this.deps.db
      .update(publication)
      .set({
        metricsNextAt: at,
        metricsAttempts: pub.metricsAttempts + 1,
        metricsError: reason,
        updatedAt: now,
      })
      .where(eq(publication.id, pub.id));
    await this.deps.enqueue.fetchMetrics({ publicationId: pub.id }, { startAfter: at });
    this.deps.logger.info(
      { publicationId: pub.id, reason, delayMs, correlationId },
      'metrics rescheduled',
    );
    return 'rescheduled';
  }

  private async stop(pub: Publication, reason: string, correlationId: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db
      .update(publication)
      .set({ metricsNextAt: null, metricsError: reason, updatedAt: now })
      .where(eq(publication.id, pub.id));
    await recordAudit(this.deps.db, {
      workspaceId: pub.workspaceId,
      actor: { type: 'system', id: 'metrics' },
      entityType: 'publication',
      entityId: pub.id,
      event: 'metrics.stopped',
      correlationId,
      data: { reason, tier: pub.metricsTier },
    });
  }

  private async overBudget(
    workspaceId: string,
    provider: Publication['provider'],
    now: Date,
  ): Promise<boolean> {
    const [row] = await this.deps.db
      .select({ n: count() })
      .from(publicationMetric)
      .where(
        and(
          eq(publicationMetric.workspaceId, workspaceId),
          eq(publicationMetric.provider, provider),
          gte(publicationMetric.fetchedAt, new Date(now.getTime() - 60 * 60_000)),
        ),
      );
    return (row?.n ?? 0) >= METRICS_HOURLY_BUDGET;
  }

  /** Per-post metric columns in Notion (only when the database has them). */
  private async writePostColumns(pub: Publication, metrics: PostMetrics, now: Date): Promise<void> {
    const [postRow] = await this.deps.db
      .select()
      .from(post)
      .where(eq(post.id, pub.postId))
      .limit(1);
    if (!postRow?.contentSourceId || !postRow.externalId) return;
    const [source] = await this.deps.db
      .select()
      .from(contentSource)
      .where(eq(contentSource.id, postRow.contentSourceId))
      .limit(1);
    if (!source || source.disconnectedAt || !source.credentialEnc) return;
    const map = (source.config as { propertyMap?: PropertyMap }).propertyMap ?? {};
    const columns: [string, number | null][] = [
      ['Impressions', metrics.impressions],
      ['Reach', metrics.reach],
      ['Reactions', metrics.reactions],
      ['Comments', metrics.comments],
      ['Shares', metrics.shares],
      ['Clicks', metrics.clicks],
    ];
    const props: Record<string, unknown> = {};
    // Several publications share one page: write the sum across the post's latest snapshots.
    const totals = await this.latestTotalsForPost(pub.postId);
    for (const [name] of columns) {
      const key = name.toLowerCase() as keyof PostMetrics;
      if (map[name]) props[map[name]] = { number: totals[key] };
    }
    if (map['Metrics Updated'])
      props[map['Metrics Updated']] = { date: { start: now.toISOString() } };
    if (Object.keys(props).length === 0) return;
    const ctx = systemContext(pub.workspaceId, 'metrics-writeback', 'metrics');
    await this.deps.contentSources.withToken(ctx, source.id, 'sync', async (token) => {
      const client = new NotionClient(
        token,
        this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      );
      await client.updatePageProperties(postRow.externalId!, props);
    });
  }

  /** Sum of the latest snapshot per publication of a post (null when no publication reports the field). */
  async latestTotalsForPost(postId: string): Promise<PostMetrics> {
    const pubs = await this.deps.db
      .select({ id: publication.id })
      .from(publication)
      .where(and(eq(publication.postId, postId), eq(publication.state, 'published')));
    const totals: PostMetrics = {
      impressions: null,
      reach: null,
      reactions: null,
      comments: null,
      shares: null,
      clicks: null,
      saves: null,
    };
    for (const p of pubs) {
      const latest = await this.latestFor(p.id);
      if (!latest) continue;
      for (const k of Object.keys(totals) as (keyof PostMetrics)[]) {
        const v = latest[k as keyof PublicationMetric] as number | null;
        if (v !== null) totals[k] = (totals[k] ?? 0) + v;
      }
    }
    return totals;
  }

  async latestFor(publicationId: string): Promise<PublicationMetric | null> {
    const rows = await this.deps.db
      .select()
      .from(publicationMetric)
      .where(eq(publicationMetric.publicationId, publicationId))
      .orderBy(publicationMetric.tier);
    return rows.at(-1) ?? null;
  }

  async historyFor(publicationId: string): Promise<PublicationMetric[]> {
    return this.deps.db
      .select()
      .from(publicationMetric)
      .where(eq(publicationMetric.publicationId, publicationId))
      .orderBy(publicationMetric.tier);
  }

  /** Maintenance: published posts of the last 30 days that never got a schedule (pre-Phase 5 or lost jobs). */
  async backfill(correlationId: string): Promise<number> {
    const now = this.deps.clock.now();
    const rows = await this.deps.db
      .select()
      .from(publication)
      .where(
        and(
          eq(publication.state, 'published'),
          gte(
            publication.publishedAt,
            new Date(now.getTime() - METRICS_BACKFILL_DAYS * 86_400_000),
          ),
          isNull(publication.metricsNextAt),
          isNull(publication.metricsError),
          lte(publication.metricsTier, 0),
        ),
      )
      .limit(200);
    let n = 0;
    for (const pub of rows) {
      if (!this.supports(pub.provider) || !pub.publishedAt) continue;
      // Start at the first tier that is still ahead, or the last one for old posts.
      const age = now.getTime() - pub.publishedAt.getTime();
      let tier = METRIC_TIERS_MS.findIndex((ms) => ms > age);
      if (tier === -1) tier = METRIC_TIERS_MS.length - 1;
      await this.deps.db
        .update(publication)
        .set({ metricsTier: tier, metricsNextAt: now, updatedAt: now })
        .where(eq(publication.id, pub.id));
      await this.deps.enqueue.fetchMetrics({ publicationId: pub.id });
      n += 1;
    }
    if (n > 0) this.deps.logger.info({ n, correlationId }, 'metrics backfill scheduled');
    return n;
  }

  /** Maintenance: retention. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - METRICS_RETENTION_DAYS * 86_400_000);
    const rows = await this.deps.db
      .delete(publicationMetric)
      .where(lt(publicationMetric.fetchedAt, cutoff))
      .returning({ id: publicationMetric.id });
    return rows.length;
  }
}

function truncate(raw: unknown): unknown {
  if (raw === undefined) return null;
  const text = JSON.stringify(raw);
  return text.length > 2000 ? { truncated: text.slice(0, 2000) } : raw;
}
