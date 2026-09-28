import { sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import type { Logger } from '../../infra/logger.js';
import type { AlertService } from './alerts.service.js';

/**
 * Phase 7 queue observability: gauges straight from pg-boss's job table and a
 * saturation check for maintenance. The thresholds below are the ones the
 * scale-out plan in architecture §20 keys on; crossing them for an hour is the
 * signal to add workers or move the queue, not a bug.
 */

export const QUEUE_WAITING_THRESHOLD = 5000;
export const QUEUE_OLDEST_WAITING_SECONDS = 600;

export interface QueueSnapshot {
  counts: { queue: string; state: string; n: number }[];
  oldestWaitingSeconds: { queue: string; seconds: number }[];
  available: boolean;
}

export interface QueueHealthDeps {
  db: Db;
  logger: Logger;
}

export class QueueHealthService {
  constructor(private readonly deps: QueueHealthDeps) {}

  /** Tolerates a missing pg-boss schema (tests, fresh databases). */
  async snapshot(): Promise<QueueSnapshot> {
    try {
      const counts = await this.deps.db.execute<{ queue: string; state: string; n: string }>(
        sql`select name as queue, state::text as state, count(*)::text as n from pgboss.job group by 1, 2`,
      );
      const oldest = await this.deps.db.execute<{ queue: string; seconds: string }>(
        sql`select name as queue, extract(epoch from (now() - min(created_on)))::text as seconds
            from pgboss.job where state = 'created' and start_after <= now() group by 1`,
      );
      return {
        counts: rowsOf<{ queue: string; state: string; n: string }>(counts).map((r) => ({
          queue: r.queue,
          state: r.state,
          n: Number(r.n),
        })),
        oldestWaitingSeconds: rowsOf<{ queue: string; seconds: string }>(oldest).map((r) => ({
          queue: r.queue,
          seconds: Math.round(Number(r.seconds)),
        })),
        available: true,
      };
    } catch (err) {
      this.deps.logger.debug({ err }, 'queue snapshot unavailable');
      return { counts: [], oldestWaitingSeconds: [], available: false };
    }
  }

  /** Prometheus lines appended to `/metrics`. */
  async render(): Promise<string> {
    const s = await this.snapshot();
    const lines: string[] = [];
    lines.push(
      '# HELP postelyo_queue_jobs Jobs in the Postgres queue by queue and state',
      '# TYPE postelyo_queue_jobs gauge',
    );
    for (const c of s.counts)
      lines.push(`postelyo_queue_jobs{queue="${c.queue}",state="${c.state}"} ${c.n}`);
    lines.push(
      '# HELP postelyo_queue_oldest_waiting_seconds Age of the oldest job waiting to be picked up',
      '# TYPE postelyo_queue_oldest_waiting_seconds gauge',
    );
    for (const o of s.oldestWaitingSeconds)
      lines.push(`postelyo_queue_oldest_waiting_seconds{queue="${o.queue}"} ${o.seconds}`);
    lines.push(
      '# HELP postelyo_queue_available 1 when the queue tables could be read',
      '# TYPE postelyo_queue_available gauge',
      `postelyo_queue_available ${s.available ? 1 : 0}`,
    );
    return lines.join('\n') + '\n';
  }

  /** Maintenance: raises `queue.saturated` per queue over threshold. */
  async check(alerts: AlertService, correlationId: string): Promise<string[]> {
    const s = await this.snapshot();
    const saturated: string[] = [];
    const waiting = new Map<string, number>();
    for (const c of s.counts) if (c.state === 'created') waiting.set(c.queue, c.n);
    for (const [queue, n] of waiting) {
      if (n > QUEUE_WAITING_THRESHOLD) saturated.push(`${queue}: ${n} waiting`);
    }
    for (const o of s.oldestWaitingSeconds) {
      if (o.seconds > QUEUE_OLDEST_WAITING_SECONDS)
        saturated.push(`${o.queue}: oldest waiting ${o.seconds}s`);
    }
    for (const line of saturated) {
      const queue = line.split(':')[0]!;
      await alerts.raise(
        'queue.saturated',
        queue,
        `Queue ${line}. See runbook "Queue saturation" for scale-out steps.`,
        null,
        correlationId,
      );
    }
    return saturated;
  }
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
}
