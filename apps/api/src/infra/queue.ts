import { PgBoss } from 'pg-boss';
import type {
  DeleteWorkspaceJobData,
  MetricsJobData,
  JobEnqueuer,
  PublishJobData,
  SyncPageJobData,
  WritebackJobData,
} from '../modules/publishing/jobs.js';
import type { Logger } from './logger.js';

/**
 * Job names are the only shared vocabulary between the scheduler/engine and the
 * worker entrypoint. Handlers are registered in src/jobs.
 */
export const JOB = {
  notionSync: 'notion-sync',
  notionSyncPage: 'notion-sync-page',
  publish: 'publish',
  writeback: 'writeback',
  maintenance: 'maintenance',
  workspaceDelete: 'workspace-delete',
  /** Phase 5: its own queue so metrics never compete with publishing. */
  metricsFetch: 'metrics-fetch',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/** Recurring ticks must never overlap. */
const SINGLETON_QUEUES: readonly JobName[] = [JOB.notionSync, JOB.maintenance];
/** One created + one active job per singleton key: duplicate sends are no-ops. */
const STATELY_QUEUES: readonly JobName[] = [
  JOB.publish,
  JOB.writeback,
  JOB.notionSyncPage,
  JOB.workspaceDelete,
  JOB.metricsFetch,
];

const ONE_DAY_SECONDS = 24 * 60 * 60;

export interface QueueOptions {
  /** api role: send-only, no maintenance/supervision threads. */
  supervise?: boolean;
}

export async function createQueue(
  databaseUrl: string,
  logger: Logger,
  opts: QueueOptions = {},
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: 'pgboss',
    ...(opts.supervise === false ? { supervise: false, schedule: false } : {}),
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  for (const name of Object.values(JOB)) {
    // Completed jobs are kept briefly for debugging; the audit log is the durable record.
    await boss.createQueue(name, {
      deleteAfterSeconds: ONE_DAY_SECONDS,
      ...(SINGLETON_QUEUES.includes(name) ? { policy: 'singleton' as const } : {}),
      ...(STATELY_QUEUES.includes(name) ? { policy: 'stately' as const } : {}),
    });
  }
  logger.info({ queues: Object.values(JOB) }, 'queue ready');
  return boss;
}

/** pg-boss implementation of the enqueue boundary (architecture §8.2, §9.4). */
export class PgBossEnqueuer implements JobEnqueuer {
  constructor(private readonly boss: PgBoss) {}

  async publish(data: PublishJobData, opts?: { startAfter?: Date }): Promise<void> {
    // Retries are the engine's job (state machine + backoff), never pg-boss's.
    await this.boss.send(JOB.publish, data, {
      singletonKey: data.publicationId,
      retryLimit: 0,
      expireInSeconds: 10 * 60,
      ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
    });
  }

  async writeback(data: WritebackJobData): Promise<void> {
    await this.boss.send(JOB.writeback, data, {
      singletonKey: data.publicationId,
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 2 * 60,
    });
  }

  async deleteWorkspace(data: DeleteWorkspaceJobData): Promise<void> {
    await this.boss.send(JOB.workspaceDelete, data, {
      singletonKey: data.workspaceId,
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 10 * 60,
      // Give the owner a moment to notice a mistake before the purge runs.
      startAfter: new Date(Date.now() + 10 * 60_000),
    });
  }

  async fetchMetrics(data: MetricsJobData, opts?: { startAfter?: Date }): Promise<void> {
    await this.boss.send(JOB.metricsFetch, data, {
      singletonKey: data.publicationId,
      retryLimit: 0,
      expireInSeconds: 5 * 60,
      ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}),
    });
  }

  async syncPage(data: SyncPageJobData): Promise<void> {
    await this.boss.send(JOB.notionSyncPage, data, {
      singletonKey: `${data.sourceId}:${data.pageId}`,
      retryLimit: 3,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 2 * 60,
    });
  }
}
