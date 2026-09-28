import { and, count, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  contentSource,
  mediaAsset,
  post,
  publication,
  socialAccount,
} from '../../infra/db/schema.js';
import type { Clock } from '../../shared/clock.js';
import { OVERDUE_AFTER_MS } from './alerts.service.js';
import type { HeartbeatService } from './heartbeat.service.js';

/**
 * Prometheus text exposition computed from the database on request
 * (architecture §19). Cheap at MVP volume; switch to a metrics registry when
 * request-level counters are needed.
 */
export class MetricsService {
  private readonly extras: (() => Promise<string>)[] = [];

  constructor(
    private readonly db: Db,
    private readonly heartbeat: HeartbeatService,
    private readonly clock: Clock,
  ) {}

  /** Phase 7: other modules append their own exposition (queue health). */
  registerExtra(render: () => Promise<string>): void {
    this.extras.push(render);
  }

  async render(): Promise<string> {
    const db = this.db;
    const now = this.clock.now();
    const lines: string[] = [];
    const gauge = (
      name: string,
      help: string,
      rows: { labels?: Record<string, string>; value: number }[],
    ) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const r of rows) {
        const labels = r.labels
          ? '{' +
            Object.entries(r.labels)
              .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
              .join(',') +
            '}'
          : '';
        lines.push(`${name}${labels} ${r.value}`);
      }
    };

    const pubStates = await db
      .select({ state: publication.state, n: count() })
      .from(publication)
      .groupBy(publication.state);
    gauge(
      'postelyo_publications',
      'Publications by state',
      pubStates.map((r) => ({ labels: { state: r.state }, value: r.n })),
    );

    const postStates = await db
      .select({ state: post.state, n: count() })
      .from(post)
      .groupBy(post.state);
    gauge(
      'postelyo_posts',
      'Posts by state',
      postStates.map((r) => ({ labels: { state: r.state }, value: r.n })),
    );

    const [overdue] = await db
      .select({ n: count() })
      .from(publication)
      .where(
        and(
          eq(publication.state, 'scheduled'),
          lt(publication.scheduledAt, new Date(now.getTime() - OVERDUE_AFTER_MS)),
          or(isNull(publication.deferredUntil), lt(publication.deferredUntil, now)),
        ),
      );
    gauge('postelyo_publications_overdue', 'Scheduled publications more than 15 minutes past due', [
      { value: overdue?.n ?? 0 },
    ]);

    const [deferred] = await db
      .select({ n: count() })
      .from(publication)
      .where(and(eq(publication.state, 'scheduled'), gt(publication.deferredUntil, now)));
    gauge('postelyo_publications_deferred', 'Scheduled publications waiting for a daily cap', [
      { value: deferred?.n ?? 0 },
    ]);

    const [wbFailed] = await db
      .select({ n: count() })
      .from(publication)
      .where(eq(publication.writebackState, 'failed'));
    gauge('postelyo_writebacks_failed', 'Publications whose Notion writeback gave up', [
      { value: wbFailed?.n ?? 0 },
    ]);

    const accounts = await db
      .select({ status: socialAccount.status, n: count() })
      .from(socialAccount)
      .where(isNull(socialAccount.disconnectedAt))
      .groupBy(socialAccount.status);
    gauge(
      'postelyo_social_accounts',
      'Connected social accounts by status',
      accounts.map((r) => ({ labels: { status: r.status }, value: r.n })),
    );

    const [sourcesError] = await db
      .select({ n: count() })
      .from(contentSource)
      .where(and(isNotNull(contentSource.lastError), isNull(contentSource.disconnectedAt)));
    gauge('postelyo_content_sources_error', 'Content sources whose last sync failed', [
      { value: sourcesError?.n ?? 0 },
    ]);

    const [mediaErrors] = await db
      .select({ n: count() })
      .from(mediaAsset)
      .where(isNotNull(mediaAsset.lastError));
    gauge('postelyo_media_assets_error', 'Media assets that failed inspection', [
      { value: mediaErrors?.n ?? 0 },
    ]);

    const age = await this.heartbeat.latestAgeSeconds();
    gauge(
      'postelyo_worker_heartbeat_age_seconds',
      'Seconds since the last worker heartbeat (-1 = never)',
      [{ value: age ?? -1 }],
    );

    let out = lines.join('\n') + '\n';
    for (const extra of this.extras) out += await extra();
    return out;
  }
}
