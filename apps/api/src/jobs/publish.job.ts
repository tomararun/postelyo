import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import { reportError } from '../infra/sentry.js';
import type { PublishEngine } from '../modules/publishing/engine.js';
import type { PublishJobData } from '../modules/publishing/jobs.js';

/** Max publish calls in flight per worker process (architecture §8.3). */
export const PUBLISH_CONCURRENCY = 5;

/**
 * Publish job consumer. The engine never throws for classified outcomes; an
 * exception here is an internal bug and is logged, leaving the publication to
 * the lease sweeper (→ ambiguous) or the stale-queued sweeper (→ re-sent).
 */
export async function registerPublishJob(
  boss: PgBoss,
  engine: PublishEngine,
  logger: Logger,
): Promise<void> {
  await boss.work<PublishJobData>(
    JOB.publish,
    { batchSize: PUBLISH_CONCURRENCY, pollingIntervalSeconds: 2 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          const started = Date.now();
          try {
            const outcome = await engine.handle(job.data, `job:${job.id}`);
            logger.info(
              {
                jobId: job.id,
                publicationId: job.data.publicationId,
                outcome,
                durationMs: Date.now() - started,
              },
              'publish job',
            );
          } catch (err) {
            logger.error(
              { err, jobId: job.id, publicationId: job.data.publicationId },
              'publish job crashed',
            );
            reportError(err, { job: 'publish', publicationId: job.data.publicationId });
          }
        }),
      );
    },
  );
}
