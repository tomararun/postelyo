import type { FastifyPluginAsync } from 'fastify';
import { BillingError, type BillingService } from '../../modules/billing/billing.service.js';
import {
  NOTION_SIGNATURE_HEADER,
  type NotionWebhookService,
} from '../../modules/content-sources/notion/notion-webhook.service.js';

export interface WebhookRoutesOptions {
  notion: NotionWebhookService;
  billing: BillingService;
}

/**
 * Inbound webhook endpoints (architecture §11.1). Unauthenticated by nature:
 * each service verifies the provider signature over the raw body, so this scope
 * parses bodies as buffers.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (app, opts) => {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    scope.post('/webhooks/notion', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.headers[NOTION_SIGNATURE_HEADER];
      const receipt = await opts.notion.receive(
        raw,
        Array.isArray(header) ? header[0] : header,
        req.id,
      );
      return reply.status(receipt.status).send(receipt.body);
    });

    /** Stripe (Phase 3): signature-checked, idempotent on event id; 2xx once the event is stored. */
    scope.post('/webhooks/stripe', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['stripe-signature'];
      try {
        const outcome = await opts.billing.handleWebhook(
          raw,
          Array.isArray(sig) ? sig[0] : sig,
          req.id,
        );
        return reply.status(200).send({ ok: true, outcome });
      } catch (err) {
        if (err instanceof BillingError)
          return reply.status(400).send({ ok: false, error: err.message });
        throw err;
      }
    });
  });
};
