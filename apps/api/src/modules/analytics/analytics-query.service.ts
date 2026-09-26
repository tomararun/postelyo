import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  publicationMetric,
  socialAccount,
  type PublicationMetric,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Clock } from '../../shared/clock.js';
import type { CanonicalContent } from '../posts/content.js';
import type { PostMetrics } from '../publishing/provider.js';
import { wallClock, zonedTimeToUtc } from '../scheduling/schedule-time.js';

/**
 * Phase 5 read models: weekly rollups per platform, top posts, hashtag
 * performance and best-time suggestions, all derived from the latest metrics
 * snapshot of each publication. Shared by the dashboard, the Notion rollup
 * writeback and the weekly report.
 */

export const METRIC_KEYS = [
  'impressions',
  'reach',
  'reactions',
  'comments',
  'shares',
  'clicks',
  'saves',
] as const;

export interface WeeklyRow {
  /** ISO week key, e.g. `2026-W40`. */
  week: string;
  /** Monday of that week (YYYY-MM-DD) in the workspace time zone. */
  weekStart: string;
  platform: string;
  posts: number;
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  saves: number | null;
  /** (reactions + comments + shares) / impressions, null without impressions. */
  engagementRate: number | null;
}

export interface TopPost {
  publicationId: string;
  postId: string;
  title: string;
  platform: string;
  accountName: string | null;
  url: string | null;
  publishedAt: Date;
  metrics: PostMetrics;
  engagement: number;
}

export interface HashtagStat {
  hashtag: string;
  posts: number;
  avgEngagement: number;
  avgImpressions: number | null;
}

export interface BestTime {
  /** 1 = Monday … 7 = Sunday, in the workspace time zone. */
  weekday: number;
  hour: number;
  posts: number;
  avgEngagementRate: number | null;
}

export interface BestTimes {
  timeZone: string;
  basis: 'history' | 'defaults';
  /** Posts per slot needed before history is trusted. */
  minimumPosts: number;
  slots: BestTime[];
}

export interface AnalyticsSummary {
  weeks: WeeklyRow[];
  topPosts: TopPost[];
  hashtags: HashtagStat[];
  bestTimes: BestTimes;
  generatedAt: Date;
}

export const BEST_TIME_MIN_POSTS = 5;
/** Platform defaults when history is too thin: Tuesday to Thursday, 09:00 and 12:00. */
export const DEFAULT_BEST_TIMES: BestTime[] = [
  { weekday: 2, hour: 9, posts: 0, avgEngagementRate: null },
  { weekday: 3, hour: 12, posts: 0, avgEngagementRate: null },
  { weekday: 4, hour: 9, posts: 0, avgEngagementRate: null },
];

/** ISO week key and Monday for an instant in a time zone. */
export function isoWeek(date: Date, timeZone: string): { week: string; weekStart: string } {
  const w = wallClock(date, timeZone);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day));
  const jsDay = day.getUTCDay() || 7;
  const monday = new Date(day.getTime() - (jsDay - 1) * 86_400_000);
  // ISO week number: the Thursday of this week decides the year.
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return {
    week: `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`,
    weekStart: monday.toISOString().slice(0, 10),
  };
}

export const engagementOf = (m: PostMetrics): number =>
  (m.reactions ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);

export const rateOf = (m: PostMetrics): number | null =>
  m.impressions && m.impressions > 0 ? engagementOf(m) / m.impressions : null;

export function hashtagsIn(content: CanonicalContent | null | undefined): string[] {
  if (!content?.blocks) return [];
  const text = content.blocks
    .map((b) =>
      b.type === 'paragraph'
        ? b.inlines.map((i) => i.text).join('')
        : b.items.map((it) => it.map((i) => i.text).join('')).join(' '),
    )
    .join(' ');
  const found = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w#])#([\p{L}\p{N}_]{2,50})/gu))
    found.add(m[2]!.toLowerCase());
  return [...found];
}

interface PublishedWithMetrics {
  publicationId: string;
  postId: string;
  title: string;
  content: CanonicalContent | null;
  provider: string;
  accountName: string | null;
  url: string | null;
  publishedAt: Date;
  metrics: PostMetrics;
}

export interface AnalyticsQueryDeps {
  db: Db;
  clock: Clock;
}

export class AnalyticsQueryService {
  constructor(private readonly deps: AnalyticsQueryDeps) {}

  async summary(workspaceId: string, timeZone: string, weeks = 8): Promise<AnalyticsSummary> {
    const now = this.deps.clock.now();
    const since = new Date(now.getTime() - weeks * 7 * 86_400_000);
    const rows = await this.published(workspaceId, since);
    return {
      weeks: weeklyRows(rows, timeZone, since, now),
      topPosts: topPosts(rows, 10),
      hashtags: hashtagStats(rows),
      bestTimes: bestTimes(rows, timeZone),
      generatedAt: now,
    };
  }

  /** Same shape as `summary` but for a fixed window, used by the weekly report. */
  async window(workspaceId: string, timeZone: string, from: Date, to: Date) {
    const rows = (await this.published(workspaceId, from)).filter(
      (r) => r.publishedAt.getTime() < to.getTime(),
    );
    return {
      totals: totalsOf(rows.map((r) => r.metrics)),
      posts: rows.length,
      byPlatform: weeklyRows(rows, timeZone, from, to),
      topPosts: topPosts(rows, 3),
    };
  }

  async bestTimes(workspaceId: string, timeZone: string): Promise<BestTimes> {
    const since = new Date(this.deps.clock.now().getTime() - 180 * 86_400_000);
    return bestTimes(await this.published(workspaceId, since), timeZone);
  }

  /** Published publications with their latest snapshot (publications without metrics are excluded). */
  private async published(workspaceId: string, since: Date): Promise<PublishedWithMetrics[]> {
    return withTenantScope(this.deps.db, workspaceId, async (tx) => {
      const pubs = await tx
        .select({
          id: publication.id,
          postId: publication.postId,
          provider: publication.provider,
          url: publication.providerPostUrl,
          publishedAt: publication.publishedAt,
          title: post.title,
          content: post.content,
          accountName: socialAccount.displayName,
        })
        .from(publication)
        .innerJoin(post, eq(post.id, publication.postId))
        .leftJoin(socialAccount, eq(socialAccount.id, publication.socialAccountId))
        .where(
          and(
            eq(publication.workspaceId, workspaceId),
            eq(publication.state, 'published'),
            gte(publication.publishedAt, since),
          ),
        );
      if (pubs.length === 0) return [];
      const metrics = await tx
        .select()
        .from(publicationMetric)
        .where(
          inArray(
            publicationMetric.publicationId,
            pubs.map((p) => p.id),
          ),
        )
        .orderBy(publicationMetric.tier);
      const latest = new Map<string, PublicationMetric>();
      for (const m of metrics) latest.set(m.publicationId, m); // ordered by tier: last wins
      const out: PublishedWithMetrics[] = [];
      for (const p of pubs) {
        const m = latest.get(p.id);
        if (!m || !p.publishedAt) continue;
        out.push({
          publicationId: p.id,
          postId: p.postId,
          title: p.title,
          content: (p.content ?? null) as CanonicalContent | null,
          provider: p.provider,
          accountName: p.accountName,
          url: p.url,
          publishedAt: p.publishedAt,
          metrics: pick(m),
        });
      }
      return out;
    });
  }
}

function pick(m: PublicationMetric): PostMetrics {
  return {
    impressions: m.impressions,
    reach: m.reach,
    reactions: m.reactions,
    comments: m.comments,
    shares: m.shares,
    clicks: m.clicks,
    saves: m.saves,
  };
}

function totalsOf(list: PostMetrics[]): PostMetrics {
  const t: PostMetrics = {
    impressions: null,
    reach: null,
    reactions: null,
    comments: null,
    shares: null,
    clicks: null,
    saves: null,
  };
  for (const m of list) {
    for (const k of METRIC_KEYS) {
      const v = m[k];
      if (v !== null) t[k] = (t[k] ?? 0) + v;
    }
  }
  return t;
}

function weeklyRows(
  rows: PublishedWithMetrics[],
  timeZone: string,
  from: Date,
  to: Date,
): WeeklyRow[] {
  const groups = new Map<
    string,
    { week: string; weekStart: string; platform: string; list: PostMetrics[] }
  >();
  const add = (week: string, weekStart: string, platform: string, m: PostMetrics) => {
    const key = `${weekStart}:${platform}`;
    const g = groups.get(key) ?? { week, weekStart, platform, list: [] };
    g.list.push(m);
    groups.set(key, g);
  };
  for (const r of rows) {
    const { week, weekStart } = isoWeek(r.publishedAt, timeZone);
    add(week, weekStart, r.provider, r.metrics);
    add(week, weekStart, 'all', r.metrics);
  }
  // Every week in the window appears for `all`, even with no posts, so charts have a continuous axis.
  for (let t = from.getTime(); t <= to.getTime(); t += 7 * 86_400_000) {
    const { week, weekStart } = isoWeek(new Date(t), timeZone);
    const key = `${weekStart}:all`;
    if (!groups.has(key)) groups.set(key, { week, weekStart, platform: 'all', list: [] });
  }
  return [...groups.values()]
    .map((g) => {
      const t = totalsOf(g.list);
      return {
        week: g.week,
        weekStart: g.weekStart,
        platform: g.platform,
        posts: g.list.length,
        ...t,
        engagementRate: rateOf(t),
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.platform.localeCompare(b.platform));
}

function topPosts(rows: PublishedWithMetrics[], n: number): TopPost[] {
  return rows
    .map((r) => ({
      publicationId: r.publicationId,
      postId: r.postId,
      title: r.title,
      platform: r.provider,
      accountName: r.accountName,
      url: r.url,
      publishedAt: r.publishedAt,
      metrics: r.metrics,
      engagement: engagementOf(r.metrics),
    }))
    .sort(
      (a, b) =>
        b.engagement - a.engagement || (b.metrics.impressions ?? 0) - (a.metrics.impressions ?? 0),
    )
    .slice(0, n);
}

function hashtagStats(rows: PublishedWithMetrics[]): HashtagStat[] {
  const by = new Map<string, { engagement: number[]; impressions: number[] }>();
  for (const r of rows) {
    for (const tag of hashtagsIn(r.content)) {
      const g = by.get(tag) ?? { engagement: [], impressions: [] };
      g.engagement.push(engagementOf(r.metrics));
      if (r.metrics.impressions !== null) g.impressions.push(r.metrics.impressions);
      by.set(tag, g);
    }
  }
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...by.entries()]
    .filter(([, g]) => g.engagement.length >= 2)
    .map(([hashtag, g]) => ({
      hashtag,
      posts: g.engagement.length,
      avgEngagement: avg(g.engagement) ?? 0,
      avgImpressions: avg(g.impressions),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 20);
}

function bestTimes(rows: PublishedWithMetrics[], timeZone: string): BestTimes {
  const buckets = new Map<
    string,
    { weekday: number; hour: number; rates: number[]; posts: number }
  >();
  for (const r of rows) {
    const w = wallClock(r.publishedAt, timeZone);
    const jsDay = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const weekday = jsDay === 0 ? 7 : jsDay;
    const key = `${weekday}:${w.hour}`;
    const b = buckets.get(key) ?? { weekday, hour: w.hour, rates: [], posts: 0 };
    b.posts += 1;
    const rate = rateOf(r.metrics);
    if (rate !== null) b.rates.push(rate);
    buckets.set(key, b);
  }
  const eligible = [...buckets.values()].filter(
    (b) => b.posts >= BEST_TIME_MIN_POSTS && b.rates.length > 0,
  );
  if (eligible.length === 0) {
    return {
      timeZone,
      basis: 'defaults',
      minimumPosts: BEST_TIME_MIN_POSTS,
      slots: DEFAULT_BEST_TIMES,
    };
  }
  const slots = eligible
    .map((b) => ({
      weekday: b.weekday,
      hour: b.hour,
      posts: b.posts,
      avgEngagementRate: b.rates.reduce((a, x) => a + x, 0) / b.rates.length,
    }))
    .sort((a, b) => (b.avgEngagementRate ?? 0) - (a.avgEngagementRate ?? 0))
    .slice(0, 3);
  return { timeZone, basis: 'history', minimumPosts: BEST_TIME_MIN_POSTS, slots };
}

/** Next instant of a best-time slot after `from` in `timeZone` (for suggestions in emails). */
export function nextSlotInstant(slot: BestTime, from: Date, timeZone: string): Date {
  for (let i = 0; i < 8; i++) {
    const day = new Date(from.getTime() + i * 86_400_000);
    const w = wallClock(day, timeZone);
    const jsDay = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const weekday = jsDay === 0 ? 7 : jsDay;
    if (weekday !== slot.weekday) continue;
    const at = zonedTimeToUtc(w.year, w.month, w.day, slot.hour, 0, 0, timeZone);
    if (at.getTime() > from.getTime()) return at;
  }
  return from;
}
