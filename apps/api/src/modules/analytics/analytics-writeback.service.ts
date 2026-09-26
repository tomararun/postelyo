import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { contentSource, workspace } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { ContentSourceService } from '../content-sources/content-source.service.js';
import { NotionClient } from '../content-sources/notion/notion-client.js';
import { propName, type PropertyMap } from '../content-sources/notion/notion-mapper.js';
import { richText } from '../content-sources/notion/notion-writeback.js';
import { systemContext } from '../tenancy/tenant-context.js';
import type { AnalyticsQueryService, BestTimes, WeeklyRow } from './analytics-query.service.js';

/**
 * Phase 5: the `Postelyo Analytics` database. One row per ISO week and
 * platform (plus `All`) for the last eight weeks, and one `Best times` row.
 * Rows are keyed in `content_source.config.analyticsRows` so writes are
 * idempotent upserts; a content hash per row avoids rewriting unchanged
 * numbers. Runs from maintenance at most once an hour per source.
 */

export const ANALYTICS_WEEKS = 8;
const MIN_INTERVAL_MS = 60 * 60_000;
const PLATFORM_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  x: 'X',
  facebook: 'Facebook Page',
  instagram: 'Instagram',
  fake: 'LinkedIn',
  all: 'All',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface AnalyticsConfig {
  analyticsDatabaseId?: string | null;
  analyticsPropertyMap?: PropertyMap;
  analyticsRows?: Record<string, string>;
  analyticsRowHashes?: Record<string, string>;
  analyticsWrittenAt?: string;
}

export interface AnalyticsWritebackDeps {
  db: Db;
  contentSources: ContentSourceService;
  analytics: AnalyticsQueryService;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class AnalyticsWritebackService {
  constructor(private readonly deps: AnalyticsWritebackDeps) {}

  /** Maintenance entry point: every active source with an analytics database. */
  async run(
    correlationId: string,
    force = false,
  ): Promise<{ sources: number; rowsWritten: number }> {
    const sources = await this.deps.db
      .select()
      .from(contentSource)
      .where(
        and(
          eq(contentSource.kind, 'notion'),
          eq(contentSource.status, 'active'),
          isNull(contentSource.disconnectedAt),
        ),
      );
    let rowsWritten = 0;
    let n = 0;
    for (const source of sources) {
      const cfg = (source.config ?? {}) as AnalyticsConfig;
      if (!cfg.analyticsDatabaseId) continue;
      const now = this.deps.clock.now();
      if (
        !force &&
        cfg.analyticsWrittenAt &&
        now.getTime() - Date.parse(cfg.analyticsWrittenAt) < MIN_INTERVAL_MS
      )
        continue;
      try {
        rowsWritten += await this.writeSource(source.id, source.workspaceId, cfg, correlationId);
        n += 1;
      } catch (err) {
        this.deps.logger.warn({ err, sourceId: source.id }, 'analytics rollup writeback failed');
      }
    }
    return { sources: n, rowsWritten };
  }

  private async writeSource(
    sourceId: string,
    workspaceId: string,
    cfg: AnalyticsConfig,
    correlationId: string,
  ): Promise<number> {
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws || ws.deletedAt) return 0;
    const summary = await this.deps.analytics.summary(
      workspaceId,
      ws.defaultTimezone,
      ANALYTICS_WEEKS,
    );
    const map = cfg.analyticsPropertyMap ?? {};
    const rows = new Map<string, Record<string, unknown>>();
    for (const r of summary.weeks) rows.set(`${r.weekStart}:${r.platform}`, weekRowProps(r, map));
    rows.set('best-times', bestTimesProps(summary.bestTimes, map));

    const ids = { ...(cfg.analyticsRows ?? {}) };
    const hashes = { ...(cfg.analyticsRowHashes ?? {}) };
    let written = 0;
    const ctx = systemContext(workspaceId, 'analytics-writeback', correlationId);
    await this.deps.contentSources.withToken(ctx, sourceId, 'sync', async (token) => {
      const client = new NotionClient(
        token,
        this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      );
      for (const [key, props] of rows) {
        const hash = createHash('sha256').update(JSON.stringify(props)).digest('hex');
        if (hashes[key] === hash && ids[key]) continue;
        const existing = ids[key];
        if (existing) {
          await client.updatePageProperties(existing, props);
        } else {
          const created = await client.createPage({
            parent: { database_id: cfg.analyticsDatabaseId },
            properties: props,
          });
          ids[key] = created.id;
        }
        hashes[key] = hash;
        written += 1;
      }
    });
    const now = this.deps.clock.now();
    await this.deps.db
      .update(contentSource)
      .set({
        config: {
          ...(cfg as Record<string, unknown>),
          analyticsRows: ids,
          analyticsRowHashes: hashes,
          analyticsWrittenAt: now.toISOString(),
        },
        updatedAt: now,
      })
      .where(eq(contentSource.id, sourceId));
    if (written > 0) {
      await recordAudit(this.deps.db, {
        workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: sourceId,
        event: 'analytics.rollup_written',
        correlationId,
        data: { rows: written },
      });
    }
    return written;
  }
}

function weekRowProps(r: WeeklyRow, map: PropertyMap): Record<string, unknown> {
  const label = PLATFORM_LABEL[r.platform] ?? r.platform;
  const props: Record<string, unknown> = {
    [propName(map, 'Name')]: { title: richText(`${r.week} · ${label}`) },
  };
  const num = (name: string, v: number | null) => {
    if (map[name]) props[map[name]] = { number: v };
  };
  if (map['Week']) props[map['Week']] = { date: { start: r.weekStart } };
  if (map['Platform']) props[map['Platform']] = { select: { name: label } };
  num('Posts', r.posts);
  num('Impressions', r.impressions);
  num('Reach', r.reach);
  num('Reactions', r.reactions);
  num('Comments', r.comments);
  num('Shares', r.shares);
  num('Clicks', r.clicks);
  num('Saves', r.saves);
  num(
    'Engagement Rate',
    r.engagementRate === null ? null : Math.round(r.engagementRate * 10_000) / 10_000,
  );
  if (map['Best Time']) props[map['Best Time']] = { rich_text: [] };
  return props;
}

export function bestTimesText(b: BestTimes): string {
  const lines = b.slots.map(
    (s) =>
      `${WEEKDAYS[s.weekday - 1]} ${String(s.hour).padStart(2, '0')}:00${
        s.avgEngagementRate !== null
          ? ` (${(s.avgEngagementRate * 100).toFixed(1)}% engagement, ${s.posts} posts)`
          : ''
      }`,
  );
  return `${b.basis === 'history' ? 'From your history' : `Platform defaults (fewer than ${b.minimumPosts} posts per slot so far)`}, ${b.timeZone}: ${lines.join('; ')}.`;
}

function bestTimesProps(b: BestTimes, map: PropertyMap): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [propName(map, 'Name')]: { title: richText('Best times to publish') },
  };
  if (map['Platform']) props[map['Platform']] = { select: { name: 'All' } };
  if (map['Best Time']) props[map['Best Time']] = { rich_text: richText(bestTimesText(b)) };
  return props;
}
