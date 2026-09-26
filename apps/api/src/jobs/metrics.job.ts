import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import type { PostMetricsService } from '../modules/analytics/metrics.service.js';
import type { MetricsJobData } from '../modules/publishing/jobs.js';

/** Metrics fetches per worker process; deliberately low so publishing is never starved (Phase 5). */
export const METRICS_CONCURRENCY = 2;

export async function registerMetricsJob(
  boss: PgBoss,
  metrics: PostMetricsService,
  logger: Logger,
): Promise<void> {
  await boss.work<MetricsJobData>(
    JOB.metricsFetch,
    { batchSize: METRICS_CONCURRENCY, pollingIntervalSeconds: 5 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            const outcome = await metrics.fetch(job.data.publicationId, `job:${job.id}`);
            logger.info(
              { jobId: job.id, publicationId: job.data.publicationId, outcome },
              'metrics job',
            );
          } catch (err) {
            // The service reschedules its own retries; an exception is a bug and is logged.
            logger.error(
              { err, jobId: job.id, publicationId: job.data.publicationId },
              'metrics job crashed',
            );
          }
        }),
      );
    },
  );
}
