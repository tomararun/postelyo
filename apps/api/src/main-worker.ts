import { hostname } from 'node:os';
import { loadEnv } from './config/env.js';
import { EnvKeyProvider } from './infra/crypto/key-provider.js';
import { createDb } from './infra/db/client.js';
import { createLogger } from './infra/logger.js';
import { createMailer } from './infra/mailer.js';
import { PgBossEnqueuer, createQueue } from './infra/queue.js';
import { initSentry } from './infra/sentry.js';
import { registerMaintenanceJob } from './jobs/maintenance.job.js';
import { registerNotionSyncPageJob } from './jobs/notion-sync-page.job.js';
import { registerNotionSyncJob } from './jobs/notion-sync.job.js';
import { registerPublishJob } from './jobs/publish.job.js';
import { startSchedulerLoop } from './jobs/scheduler.job.js';
import { registerWorkspaceDeleteJob } from './jobs/workspace-delete.job.js';
import { registerWritebackJob } from './jobs/writeback.job.js';
import { buildServices } from './services.js';
import { installShutdown } from './shared/shutdown.js';

const HEARTBEAT_MS = 30_000;

/**
 * Worker role (architecture §2.1): Notion sync every minute, scheduler tick
 * every 30 s, publish and writeback consumers, maintenance every 5 minutes,
 * and a liveness heartbeat the api role watches.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const instanceId = env.INSTANCE_ID ?? `${hostname()}-${process.pid}`;
  const logger = createLogger({ ...env, INSTANCE_ID: instanceId }, 'worker');
  if (initSentry(env, 'worker')) logger.info('sentry enabled');
  const database = createDb(env.DATABASE_URL);
  const boss = await createQueue(env.DATABASE_URL, logger);
  const services = buildServices({
    env,
    db: database.db,
    logger,
    keyProvider: EnvKeyProvider.fromEnv(env.ENCRYPTION_KEYS),
    mailer: createMailer(env, logger),
    enqueue: new PgBossEnqueuer(boss),
    workerId: instanceId,
  });
  logger.info(
    {
      providers: services.providers.ids(),
      providerMode: env.PROVIDER_MODE,
      version: env.APP_VERSION ?? null,
    },
    'providers registered',
  );

  await registerNotionSyncJob(boss, services.notionSync, logger);
  await registerNotionSyncPageJob(boss, services.notionSync, logger);
  await registerPublishJob(boss, services.engine, logger);
  await registerWritebackJob(boss, services.resultWriteback, logger);
  await registerMaintenanceJob(
    boss,
    {
      reconciliation: services.reconciliation,
      alerts: services.alerts,
      tokenExpiry: services.tokenExpiry,
      digest: services.digest,
      heartbeat: services.heartbeat,
      notionWebhooks: services.notionWebhooks,
      media: services.media,
      billing: services.billing,
    },
    logger,
  );
  await registerWorkspaceDeleteJob(boss, services.deletion, logger);
  const schedulerLoop = startSchedulerLoop(services.scheduler, logger);

  const startedAt = new Date();
  const beat = () =>
    services.heartbeat
      .beat(instanceId, startedAt, env.APP_VERSION ?? null)
      .catch((err: unknown) => logger.warn({ err }, 'heartbeat write failed'));
  await beat();
  const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);

  installShutdown(logger, async () => {
    clearInterval(heartbeat);
    schedulerLoop.stop();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await database.close();
  });

  logger.info({ instanceId }, 'worker started');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
