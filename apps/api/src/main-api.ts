import { hostname } from 'node:os';
import { loadEnv } from './config/env.js';
import { EnvKeyProvider } from './infra/crypto/key-provider.js';
import { createDb } from './infra/db/client.js';
import { createLogger } from './infra/logger.js';
import { createMailer } from './infra/mailer.js';
import { PgBossEnqueuer, createQueue } from './infra/queue.js';
import { initSentry } from './infra/sentry.js';
import { buildServer } from './http/server.js';
import { buildServices } from './services.js';
import { installShutdown } from './shared/shutdown.js';

/** The api watches the worker's heartbeat because a dead worker cannot alert on itself. */
const HEARTBEAT_CHECK_MS = 60_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'api');
  if (initSentry(env, 'api')) logger.info('sentry enabled');
  const database = createDb(env.DATABASE_URL);
  const mailer = createMailer(env, logger);
  const keyProvider = EnvKeyProvider.fromEnv(env.ENCRYPTION_KEYS);
  // Send-only queue handle: operator actions (resolve) enqueue writebacks.
  const boss = await createQueue(env.DATABASE_URL, logger, { supervise: false });
  const services = buildServices({
    env,
    db: database.db,
    logger,
    keyProvider,
    mailer,
    enqueue: new PgBossEnqueuer(boss),
    workerId: env.INSTANCE_ID ?? `${hostname()}-api-${process.pid}`,
  });

  const app = await buildServer({
    env,
    logger,
    db: database.db,
    mailer,
    keyProvider,
    services,
    readiness: async () => ({ db: await database.ping().catch(() => false) }),
  });

  const heartbeatCheck = setInterval(() => {
    void services.alerts
      .evaluateHeartbeat(`heartbeat-check:${Date.now()}`)
      .catch((err: unknown) => logger.warn({ err }, 'heartbeat check failed'));
  }, HEARTBEAT_CHECK_MS);

  installShutdown(logger, async () => {
    clearInterval(heartbeatCheck);
    await app.close();
    await boss.stop({ graceful: false, timeout: 5_000 });
    await database.close();
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(
    {
      port: env.PORT,
      providerMode: env.PROVIDER_MODE,
      mailTransport: env.MAIL_TRANSPORT,
      linkedinConfigured: Boolean(env.LINKEDIN_CLIENT_ID),
      alertEmailConfigured: Boolean(env.ALERT_EMAIL),
      encryptionKeyId: keyProvider.currentKeyId,
      version: env.APP_VERSION ?? null,
    },
    'api listening',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
