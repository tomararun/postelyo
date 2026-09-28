import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import { reportError } from '../infra/sentry.js';
import type { NotionWebhookService } from '../modules/content-sources/notion/notion-webhook.service.js';
import type { BillingService } from '../modules/billing/billing.service.js';
import type { MediaService } from '../modules/media/media.service.js';
import type { AlertService } from '../modules/ops/alerts.service.js';
import type { DigestService } from '../modules/ops/digest.service.js';
import type { HeartbeatService } from '../modules/ops/heartbeat.service.js';
import type { TokenExpiryService } from '../modules/ops/token-expiry.service.js';
import type { ReconciliationService } from '../modules/publishing/reconciliation.service.js';
import type { PublishEngine } from '../modules/publishing/engine.js';
import type { AnalyticsWritebackService } from '../modules/analytics/analytics-writeback.service.js';
import type { PostMetricsService } from '../modules/analytics/metrics.service.js';
import type { WeeklyReportService } from '../modules/analytics/weekly-report.service.js';
import type { ApiKeyService } from '../modules/enterprise/api-key.service.js';
import type { AuditArchiveService } from '../modules/enterprise/audit-archive.service.js';
import type { QueueHealthService } from '../modules/ops/queue-health.service.js';

/** Every 5 minutes: reconciliation, alert evaluation, token lifecycle notices, daily digest, housekeeping. */
export const MAINTENANCE_CRON = '*/5 * * * *';

export interface MaintenanceDeps {
  reconciliation: ReconciliationService;
  alerts: AlertService;
  tokenExpiry: TokenExpiryService;
  digest: DigestService;
  heartbeat: HeartbeatService;
  notionWebhooks: NotionWebhookService;
  media: MediaService;
  billing: BillingService;
  /** Phase 4: pending first comments are retried here. */
  engine?: PublishEngine;
  /** Phase 5 */
  postMetrics?: PostMetricsService;
  analyticsWriteback?: AnalyticsWritebackService;
  weeklyReport?: WeeklyReportService;
  /** Phase 7 */
  apiKeys?: ApiKeyService;
  auditArchive?: AuditArchiveService;
  queueHealth?: QueueHealthService;
}

export async function runMaintenance(
  deps: MaintenanceDeps,
  correlationId: string,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  // Reconciliation first, so an ambiguous outcome the provider can confirm never pages anyone.
  const reconciliation = await deps.reconciliation.run(correlationId);
  const alerts = await deps.alerts.evaluateWorker(correlationId);
  const tokens = await deps.tokenExpiry.run(correlationId);
  const digest = await deps.digest.run(correlationId);
  await deps.heartbeat.prune();
  const webhooksPruned = await deps.notionWebhooks.prune();
  const mediaPruned = await deps.media.pruneUnreferenced();
  const gracesExpired = await deps.billing.expireGracePeriods(correlationId);
  const commentsPosted = deps.engine ? await deps.engine.retryPendingComments(correlationId) : 0;
  const metricsBackfilled = deps.postMetrics ? await deps.postMetrics.backfill(correlationId) : 0;
  const metricsPruned = deps.postMetrics ? await deps.postMetrics.prune() : 0;
  const analyticsRows = deps.analyticsWriteback
    ? (await deps.analyticsWriteback.run(correlationId)).rowsWritten
    : 0;
  const weeklyReports = deps.weeklyReport ? await deps.weeklyReport.run(correlationId) : 0;
  const idempotencyPruned = deps.apiKeys ? await deps.apiKeys.pruneIdempotency() : 0;
  const auditArchived = deps.auditArchive ? await deps.auditArchive.archive(correlationId) : 0;
  const queueSaturated = deps.queueHealth
    ? await deps.queueHealth.check(deps.alerts, correlationId)
    : [];
  logger.info(
    {
      correlationId,
      reconciliation,
      alerts,
      tokens,
      digest,
      webhooksPruned,
      mediaPruned,
      gracesExpired,
      commentsPosted,
      metricsBackfilled,
      metricsPruned,
      analyticsRows,
      weeklyReports,
      idempotencyPruned,
      auditArchived,
      queueSaturated,
      durationMs: Date.now() - started,
    },
    'maintenance run',
  );
}

export async function registerMaintenanceJob(
  boss: PgBoss,
  deps: MaintenanceDeps,
  logger: Logger,
): Promise<void> {
  await boss.schedule(JOB.maintenance, MAINTENANCE_CRON, {}, { tz: 'UTC' });
  await boss.work(JOB.maintenance, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      try {
        await runMaintenance(deps, `job:${job.id}`, logger);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'maintenance run crashed');
        reportError(err, { job: 'maintenance' });
      }
    }
  });
}
