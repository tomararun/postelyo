import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { alertState, contentSource, publication, workspace } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { alertEmail } from '../notifications/emails.js';
import type { NotificationTargets } from '../notifications/targets.js';
import type { HeartbeatService } from './heartbeat.service.js';

export type AlertKind =
  | 'publication.overdue'
  | 'publication.stuck_queued'
  | 'publication.ambiguous'
  | 'publication.writeback_failed'
  | 'content_source.sync_failed'
  | 'worker.heartbeat_missing'
  | 'ops.daily_digest';

/** Re-alert cadence while a condition persists (architecture §10.4). */
export const ALERT_WINDOWS_MS: Record<AlertKind, number> = {
  'publication.overdue': 60 * 60_000,
  'publication.stuck_queued': 60 * 60_000,
  'publication.ambiguous': 6 * 60 * 60_000,
  'publication.writeback_failed': 6 * 60 * 60_000,
  'content_source.sync_failed': 60 * 60_000,
  'worker.heartbeat_missing': 30 * 60_000,
  'ops.daily_digest': 20 * 60 * 60_000,
};

export const OVERDUE_AFTER_MS = 15 * 60_000;
export const STUCK_QUEUED_AFTER_MS = 10 * 60_000;
export const HEARTBEAT_MISSING_AFTER_S = 120;

export interface AlertServiceDeps {
  db: Db;
  mailer: Mailer;
  targets: NotificationTargets;
  heartbeat: HeartbeatService;
  clock: Clock;
  logger: Logger;
  appBaseUrl: string;
  environment: string;
}

export interface EvaluateSummary {
  checked: number;
  sent: number;
  suppressed: number;
  skippedNoRecipient: boolean;
}

/**
 * Operational alerting (architecture §10.4, §19). Conditions are evaluated by
 * polling; de-duplication lives in the database so several processes can run
 * the checks without double-sending.
 */
export class AlertService {
  constructor(private readonly deps: AlertServiceDeps) {}

  /**
   * Atomically claims the right to notify for (kind, entityKey). Returns false
   * when a notification was sent within the kind's window.
   */
  async claim(
    kind: AlertKind,
    entityKey: string,
    workspaceId: string | null,
    message: string,
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    const windowStart = new Date(now.getTime() - ALERT_WINDOWS_MS[kind]);
    const rows = await this.deps.db
      .insert(alertState)
      .values({ kind, entityKey, workspaceId, lastSentAt: now, lastMessage: message })
      .onConflictDoUpdate({
        target: [alertState.kind, alertState.entityKey],
        set: { lastSentAt: now, sendCount: sql`${alertState.sendCount} + 1`, lastMessage: message },
        setWhere: lt(alertState.lastSentAt, windowStart),
      })
      .returning({ kind: alertState.kind });
    return rows.length > 0;
  }

  /** Sends an operational alert unless suppressed or no recipient is configured. */
  async raise(
    kind: AlertKind,
    entityKey: string,
    message: string,
    workspaceId: string | null,
    correlationId: string,
    link?: string,
  ): Promise<'sent' | 'suppressed' | 'no_recipient'> {
    const to = this.deps.targets.alertRecipient();
    if (!to) {
      this.deps.logger.warn({ kind, entityKey }, 'ALERT (no ALERT_EMAIL configured): ' + message);
      return 'no_recipient';
    }
    if (!(await this.claim(kind, entityKey, workspaceId, message))) return 'suppressed';
    const email = alertEmail({ kind, message, link, environment: this.deps.environment });
    await this.deps.mailer.send({ to, ...email });
    // Phase 3: a workspace may ask for a copy of alerts that concern it.
    const copy = await this.deps.targets.alertCopyFor(workspaceId);
    if (copy && copy !== to) await this.deps.mailer.send({ to: copy, ...email });
    await recordAudit(this.deps.db, {
      workspaceId,
      actor: { type: 'system', id: 'alerts' },
      entityType: 'alert',
      entityId: `${kind}:${entityKey}`,
      event: 'alert.sent',
      correlationId,
      data: { kind, entityKey, recipientKind: 'alert_email' },
    });
    this.deps.logger.warn({ kind, entityKey, workspaceId }, 'ALERT sent: ' + message);
    return 'sent';
  }

  /** Checks that need the database only; run from the worker's maintenance job. */
  async evaluateWorker(correlationId: string): Promise<EvaluateSummary> {
    const summary: EvaluateSummary = {
      checked: 0,
      sent: 0,
      suppressed: 0,
      skippedNoRecipient: !this.deps.targets.alertRecipient(),
    };
    const now = this.deps.clock.now();
    const tally = (r: 'sent' | 'suppressed' | 'no_recipient') => {
      summary.checked += 1;
      if (r === 'sent') summary.sent += 1;
      if (r === 'suppressed') summary.suppressed += 1;
    };
    const pubLink = (wsId: string, id: string) =>
      `${this.deps.appBaseUrl}/w/${wsId}/publications/${id}`;

    // Rows parked by the daily cap are late on purpose and are not overdue.
    const overdue = await this.deps.db
      .select({
        id: publication.id,
        workspaceId: publication.workspaceId,
        scheduledAt: publication.scheduledAt,
      })
      .from(publication)
      .where(
        and(
          eq(publication.state, 'scheduled'),
          lt(publication.scheduledAt, new Date(now.getTime() - OVERDUE_AFTER_MS)),
          or(isNull(publication.deferredUntil), lt(publication.deferredUntil, now)),
        ),
      )
      .limit(50);
    for (const p of overdue) {
      const late = Math.round((now.getTime() - p.scheduledAt.getTime()) / 60_000);
      tally(
        await this.raise(
          'publication.overdue',
          p.id,
          `Publication ${p.id} was due at ${p.scheduledAt.toISOString()} and is ${late} min overdue but still scheduled. Is the worker running?`,
          p.workspaceId,
          correlationId,
          pubLink(p.workspaceId, p.id),
        ),
      );
    }

    const stuck = await this.deps.db
      .select({
        id: publication.id,
        workspaceId: publication.workspaceId,
        queuedAt: publication.queuedAt,
      })
      .from(publication)
      .where(
        and(
          eq(publication.state, 'queued'),
          lt(publication.queuedAt, new Date(now.getTime() - STUCK_QUEUED_AFTER_MS)),
        ),
      )
      .limit(50);
    for (const p of stuck) {
      tally(
        await this.raise(
          'publication.stuck_queued',
          p.id,
          `Publication ${p.id} has been queued since ${p.queuedAt?.toISOString() ?? '?'} without a worker picking it up.`,
          p.workspaceId,
          correlationId,
          pubLink(p.workspaceId, p.id),
        ),
      );
    }

    const ambiguous = await this.deps.db
      .select({
        id: publication.id,
        workspaceId: publication.workspaceId,
        message: publication.lastErrorMessage,
        reconcileAttempts: publication.reconcileAttempts,
      })
      .from(publication)
      .where(eq(publication.state, 'ambiguous'))
      .limit(50);
    for (const p of ambiguous) {
      tally(
        await this.raise(
          'publication.ambiguous',
          p.id,
          `Publication ${p.id} needs review: ${p.message ?? 'provider outcome unknown'}. Automatic reconciliation checked the provider ${p.reconcileAttempts} time(s) without a unique match. Check the provider and resolve it as published or failed. It will not be retried automatically.`,
          p.workspaceId,
          correlationId,
          pubLink(p.workspaceId, p.id),
        ),
      );
    }

    const wbFailed = await this.deps.db
      .select({
        id: publication.id,
        workspaceId: publication.workspaceId,
        state: publication.state,
      })
      .from(publication)
      .where(eq(publication.writebackState, 'failed'))
      .limit(50);
    for (const p of wbFailed) {
      tally(
        await this.raise(
          'publication.writeback_failed',
          p.id,
          `Publication ${p.id} is ${p.state} but Notion could not be updated after repeated attempts. The database is the source of truth; check the Notion connection.`,
          p.workspaceId,
          correlationId,
          pubLink(p.workspaceId, p.id),
        ),
      );
    }

    const syncFailed = await this.deps.db
      .select({
        id: contentSource.id,
        workspaceId: contentSource.workspaceId,
        lastError: contentSource.lastError,
        status: contentSource.status,
        workspaceName: workspace.name,
      })
      .from(contentSource)
      .innerJoin(workspace, eq(workspace.id, contentSource.workspaceId))
      .where(and(isNotNull(contentSource.lastError), isNull(contentSource.disconnectedAt)))
      .limit(50);
    for (const s of syncFailed) {
      tally(
        await this.raise(
          'content_source.sync_failed',
          s.id,
          `Notion sync for workspace "${s.workspaceName}" is failing (${s.status}): ${s.lastError ?? 'unknown error'}.`,
          s.workspaceId,
          correlationId,
          `${this.deps.appBaseUrl}/w/${s.workspaceId}/connections`,
        ),
      );
    }
    return summary;
  }

  /** Run from the api role: a dead worker cannot report itself. */
  async evaluateHeartbeat(
    correlationId: string,
  ): Promise<'ok' | 'sent' | 'suppressed' | 'no_recipient' | 'unknown'> {
    const age = await this.deps.heartbeat.latestAgeSeconds();
    if (age === null) return 'unknown';
    if (age < HEARTBEAT_MISSING_AFTER_S) return 'ok';
    return this.raise(
      'worker.heartbeat_missing',
      'global',
      `No worker heartbeat for ${age} seconds. Scheduled posts are not being published until a worker is running.`,
      null,
      correlationId,
    );
  }
}
