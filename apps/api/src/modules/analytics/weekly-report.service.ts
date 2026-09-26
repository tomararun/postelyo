import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { membership, user, workspace, type Workspace } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { wallClock, zonedTimeToUtc } from '../scheduling/schedule-time.js';
import type { PostMetrics } from '../publishing/provider.js';
import { bestTimesText } from './analytics-writeback.service.js';
import { isoWeek, type AnalyticsQueryService, type TopPost } from './analytics-query.service.js';

/**
 * Phase 5 weekly report: Monday morning (08:00 workspace time) an email to the
 * owners and admins who have not opted out, covering the previous ISO week
 * against the one before. Sent at most once per workspace and week; the
 * marker lives in `workspace.settings.weeklyReportLastWeek`.
 */

export const WEEKLY_REPORT_HOUR = 8;

export interface WeeklyReportDeps {
  db: Db;
  mailer: Mailer;
  analytics: AnalyticsQueryService;
  clock: Clock;
  logger: Logger;
  appBaseUrl: string;
  environment: string;
}

export interface WeeklyReportContent {
  subject: string;
  text: string;
}

export class WeeklyReportService {
  constructor(private readonly deps: WeeklyReportDeps) {}

  /** Maintenance entry point. */
  async run(correlationId: string): Promise<number> {
    const now = this.deps.clock.now();
    const workspaces = await this.deps.db
      .select()
      .from(workspace)
      .where(isNull(workspace.deletedAt));
    let sent = 0;
    for (const ws of workspaces) {
      try {
        if (await this.maybeSend(ws, now, correlationId)) sent += 1;
      } catch (err) {
        this.deps.logger.warn({ err, workspaceId: ws.id }, 'weekly report failed');
      }
    }
    return sent;
  }

  /** Sends when it is Monday after 08:00 locally and this week's report has not gone out. */
  async maybeSend(
    ws: Workspace,
    now: Date,
    correlationId: string,
    force = false,
  ): Promise<boolean> {
    const tz = ws.defaultTimezone;
    const w = wallClock(now, tz);
    const jsDay = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const isMonday = jsDay === 1;
    const { week } = isoWeek(now, tz);
    const settings = (ws.settings ?? {}) as Record<string, unknown>;
    if (!force) {
      if (!isMonday || w.hour < WEEKLY_REPORT_HOUR) return false;
      if (settings['weeklyReportLastWeek'] === week) return false;
    }
    const recipients = await this.recipients(ws.id);
    if (recipients.length === 0) return false;

    // The report covers last week (Monday 00:00 to this Monday 00:00 local).
    const thisMonday = zonedTimeToUtc(
      w.year,
      w.month,
      w.day - (jsDay === 0 ? 6 : jsDay - 1),
      0,
      0,
      0,
      tz,
    );
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86_400_000);
    const prevMonday = new Date(lastMonday.getTime() - 7 * 86_400_000);
    const current = await this.deps.analytics.window(ws.id, tz, lastMonday, thisMonday);
    const previous = await this.deps.analytics.window(ws.id, tz, prevMonday, lastMonday);
    const best = await this.deps.analytics.bestTimes(ws.id, tz);
    const content = weeklyReportEmail({
      workspaceName: ws.name,
      environment: this.deps.environment,
      week: isoWeek(lastMonday, tz).week,
      current,
      previous,
      bestTimes: bestTimesText(best),
      link: `${this.deps.appBaseUrl}/w/${ws.id}/analytics`,
    });
    for (const to of recipients) await this.deps.mailer.send({ to, ...content });
    await this.deps.db
      .update(workspace)
      .set({ settings: { ...settings, weeklyReportLastWeek: week }, updatedAt: now })
      .where(eq(workspace.id, ws.id));
    await recordAudit(this.deps.db, {
      workspaceId: ws.id,
      actor: { type: 'system', id: 'weekly-report' },
      entityType: 'workspace',
      entityId: ws.id,
      event: 'report.weekly_sent',
      correlationId,
      data: { week, recipients: recipients.length, posts: current.posts },
    });
    return true;
  }

  private async recipients(workspaceId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ email: user.email })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(
        and(
          eq(membership.workspaceId, workspaceId),
          inArray(membership.role, ['owner', 'admin']),
          eq(membership.weeklyReport, true),
        ),
      );
    return rows.map((r) => r.email);
  }
}

interface WindowSummary {
  totals: PostMetrics;
  posts: number;
  byPlatform: {
    platform: string;
    posts: number;
    impressions: number | null;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    clicks: number | null;
  }[];
  topPosts: TopPost[];
}

export function weeklyReportEmail(input: {
  workspaceName: string;
  environment: string;
  week: string;
  current: WindowSummary;
  previous: WindowSummary;
  bestTimes: string;
  link: string;
}): WeeklyReportContent {
  const fmt = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
  const delta = (a: number | null, b: number | null) => {
    if (a === null || b === null) return '';
    if (b === 0) return a === 0 ? ' (±0)' : ' (new)';
    const pct = Math.round(((a - b) / b) * 100);
    return ` (${pct >= 0 ? '+' : ''}${pct}%)`;
  };
  const c = input.current.totals;
  const p = input.previous.totals;
  const lines = [
    `Postelyo weekly report for ${input.workspaceName} · ${input.week}`,
    '',
    `Posts published: ${input.current.posts}${delta(input.current.posts, input.previous.posts)}`,
    `Impressions: ${fmt(c.impressions)}${delta(c.impressions, p.impressions)}`,
    `Reactions: ${fmt(c.reactions)}${delta(c.reactions, p.reactions)}`,
    `Comments: ${fmt(c.comments)}${delta(c.comments, p.comments)}`,
    `Shares: ${fmt(c.shares)}${delta(c.shares, p.shares)}`,
    `Clicks: ${fmt(c.clicks)}${delta(c.clicks, p.clicks)}`,
    '',
    'By platform:',
    ...input.current.byPlatform
      .filter((r) => r.platform !== 'all' && r.posts > 0)
      .map(
        (r) =>
          `- ${r.platform}: ${r.posts} posts, ${fmt(r.impressions)} impressions, ${fmt((r.reactions ?? 0) + (r.comments ?? 0) + (r.shares ?? 0))} engagements`,
      ),
    '',
    'Top posts:',
    ...(input.current.topPosts.length > 0
      ? input.current.topPosts.map(
          (t, i) =>
            `${i + 1}. ${t.title} (${t.platform}${t.accountName ? `, ${t.accountName}` : ''}): ${t.engagement} engagements, ${fmt(t.metrics.impressions)} impressions${t.url ? ` · ${t.url}` : ''}`,
        )
      : ['- no posts with metrics last week']),
    '',
    `Best times: ${input.bestTimes}`,
    '',
    `Details: ${input.link}`,
    'You receive this because you are an owner or admin of the workspace; turn it off in Settings.',
  ];
  return {
    subject: `[Postelyo${input.environment === 'production' ? '' : ` ${input.environment}`}] Weekly report · ${input.workspaceName} · ${input.week}`,
    text: lines.join('\n'),
  };
}
