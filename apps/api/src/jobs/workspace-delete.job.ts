import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import { reportError } from '../infra/sentry.js';
import type { DeleteWorkspaceJobData } from '../modules/publishing/jobs.js';
import type { WorkspaceDeletionService } from '../modules/workspaces/workspace-deletion.service.js';

/** Purges a soft-deleted workspace (Phase 3). Retried by pg-boss; skipped if the row is not soft-deleted. */
export async function registerWorkspaceDeleteJob(
  boss: PgBoss,
  deletion: WorkspaceDeletionService,
  logger: Logger,
): Promise<void> {
  await boss.work<DeleteWorkspaceJobData>(JOB.workspaceDelete, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      try {
        const outcome = await deletion.purge(job.data.workspaceId, `job:${job.id}`);
        logger.info(
          { jobId: job.id, workspaceId: job.data.workspaceId, outcome },
          'workspace delete job',
        );
      } catch (err) {
        logger.error(
          { err, jobId: job.id, workspaceId: job.data.workspaceId },
          'workspace delete failed',
        );
        reportError(err, { job: 'workspace-delete', workspaceId: job.data.workspaceId });
        throw err;
      }
    }
  });
}
