import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import type { ResultWritebackService } from '../modules/content-sources/notion/result-writeback.service.js';
import type { WritebackJobData } from '../modules/publishing/jobs.js';

/** Writeback attempts per publication before the row is marked `writeback_state = failed`. */
export const WRITEBACK_MAX_ATTEMPTS = 6;

/**
 * Result writeback consumer (architecture §10.5). Throws on Notion transport
 * errors so pg-boss retries with backoff; once the attempt budget is spent the
 * publication is marked failed for writeback and the database remains the truth.
 */
export async function registerWritebackJob(
  boss: PgBoss,
  writeback: ResultWritebackService,
  logger: Logger,
): Promise<void> {
  await boss.work<WritebackJobData>(
    JOB.writeback,
    { batchSize: 3, pollingIntervalSeconds: 2 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          try {
            const outcome = await writeback.writeback(job.data.publicationId, `job:${job.id}`);
            logger.info(
              { jobId: job.id, publicationId: job.data.publicationId, outcome },
              'writeback job',
            );
          } catch (err) {
            const attempts = await writeback.attempts(job.data.publicationId);
            const giveUp = attempts >= WRITEBACK_MAX_ATTEMPTS;
            logger.warn(
              { err, jobId: job.id, publicationId: job.data.publicationId, attempts, giveUp },
              'writeback job failed',
            );
            if (giveUp) {
              await writeback.markFailed(job.data.publicationId);
              return;
            }
            throw err;
          }
        }),
      );
    },
  );
}
