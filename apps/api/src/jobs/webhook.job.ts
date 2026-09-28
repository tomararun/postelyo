import type { PgBoss } from 'pg-boss';
import type { Logger } from '../infra/logger.js';
import { JOB } from '../infra/queue.js';
import { reportError } from '../infra/sentry.js';
import type { WebhookService } from '../modules/enterprise/webhook.service.js';

/** Every minute: turn new audit rows into deliveries, then send everything that is due. */
export const WEBHOOK_CRON = '* * * * *';

export async function runWebhookTick(
  webhooks: WebhookService,
  correlationId: string,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const dispatched = await webhooks.dispatch(correlationId);
  const delivered = await webhooks.deliverDue(correlationId);
  if (dispatched.deliveries > 0 || delivered.delivered > 0 || delivered.failed > 0) {
    logger.info(
      { correlationId, ...dispatched, ...delivered, durationMs: Date.now() - started },
      'webhook tick',
    );
  }
}

export async function registerWebhookJob(
  boss: PgBoss,
  webhooks: WebhookService,
  logger: Logger,
): Promise<void> {
  await boss.schedule(JOB.webhookDispatch, WEBHOOK_CRON, {}, { tz: 'UTC' });
  await boss.work(JOB.webhookDispatch, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      try {
        await runWebhookTick(webhooks, `job:${job.id}`, logger);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'webhook tick crashed');
        reportError(err, { job: 'webhook-dispatch' });
      }
    }
  });
}
