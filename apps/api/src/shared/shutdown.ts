import type { Logger } from '../infra/logger.js';

/**
 * Graceful shutdown on SIGTERM/SIGINT (architecture §18.2): stop taking work,
 * finish in-flight work within the deadline, then exit.
 */
export function installShutdown(
  logger: Logger,
  stop: () => Promise<void>,
  deadlineMs = 35_000,
): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutdown requested');
    const timer = setTimeout(() => {
      logger.error('shutdown deadline exceeded, exiting');
      process.exit(1);
    }, deadlineMs);
    timer.unref();
    stop()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}
