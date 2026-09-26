import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import { reportError } from '../infra/sentry.js';
import { NotionApiError } from '../modules/content-sources/notion/notion-client.js';
import type { NotionSyncService } from '../modules/content-sources/notion/notion-sync.service.js';
import type { SyncPageJobData } from '../modules/publishing/jobs.js';

/**
 * Webhook-triggered single-page sync (architecture §11.1). Transport errors
 * are rethrown so pg-boss retries; anything else is logged, because the
 * next polling sync will see the page anyway.
 */
export async function registerNotionSyncPageJob(
  boss: PgBoss,
  sync: NotionSyncService,
  logger: Logger,
): Promise<void> {
  await boss.work<SyncPageJobData>(
    JOB.notionSyncPage,
    { batchSize: 3, pollingIntervalSeconds: 2 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          const started = Date.now();
          try {
            const summary = await sync.syncPage(
              job.data.workspaceId,
              job.data.sourceId,
              job.data.pageId,
              `job:${job.id}`,
            );
            logger.info(
              {
                jobId: job.id,
                pageId: job.data.pageId,
                actions: summary.actions,
                writebacks: summary.writebacks,
                errors: summary.errors.length,
                durationMs: Date.now() - started,
              },
              'notion sync-page job',
            );
          } catch (err) {
            logger.warn({ err, jobId: job.id, pageId: job.data.pageId }, 'sync-page job failed');
            if (err instanceof NotionApiError && err.code !== 'unauthorized') throw err;
            reportError(err, { job: 'notion-sync-page', pageId: job.data.pageId });
          }
        }),
      );
    },
  );
}
