import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import type { NotionSyncService } from '../modules/content-sources/notion/notion-sync.service.js';

/** Default poll cadence (architecture §2.2): once a minute across all active sources. */
export const NOTION_SYNC_CRON = '* * * * *';

/**
 * Registers the recurring Notion sync. The queue is created with the singleton
 * policy, so a slow run never overlaps with the next tick.
 */
export async function registerNotionSyncJob(
  boss: PgBoss,
  sync: NotionSyncService,
  logger: Logger,
): Promise<void> {
  await boss.schedule(JOB.notionSync, NOTION_SYNC_CRON, {}, { tz: 'UTC' });
  await boss.work(JOB.notionSync, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const started = Date.now();
      const summaries = await sync.syncAllActive(`job:${job.id}`);
      const totals = summaries.reduce(
        (acc, s) => ({
          sources: acc.sources + 1,
          pages: acc.pages + s.pagesSeen,
          writebacks: acc.writebacks + s.writebacks,
          errors: acc.errors + s.errors.length,
        }),
        { sources: 0, pages: 0, writebacks: 0, errors: 0 },
      );
      logger.info(
        { jobId: job.id, ...totals, durationMs: Date.now() - started },
        'notion sync tick',
      );
    }
  });
}
