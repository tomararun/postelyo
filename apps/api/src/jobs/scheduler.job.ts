import type { Logger } from '../infra/logger.js';
import type { SchedulerService } from '../modules/scheduling/scheduler.service.js';

/** Tick cadence (architecture §8.2). Cron granularity is a minute, so this runs in-process. */
export const SCHEDULER_TICK_MS = 30_000;

/**
 * Runs the scheduler tick on an interval. Overlap inside one process is
 * prevented locally; across processes the tick's advisory lock makes running
 * several workers safe.
 */
export function startSchedulerLoop(
  scheduler: SchedulerService,
  logger: Logger,
  intervalMs = SCHEDULER_TICK_MS,
): { stop: () => void } {
  let running = false;
  let seq = 0;
  const run = async () => {
    if (running) return;
    running = true;
    const correlationId = `tick:${Date.now()}:${++seq}`;
    try {
      await scheduler.tick(correlationId);
    } catch (err) {
      logger.error({ err, correlationId }, 'scheduler tick crashed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  void run();
  return {
    stop: () => clearInterval(timer),
  };
}
