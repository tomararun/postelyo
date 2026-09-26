import type { FastifyPluginAsync } from 'fastify';
import {
  NOTION_SIGNATURE_HEADER,
  type NotionWebhookService,
} from '../../modules/content-sources/notion/notion-webhook.service.js';

/**
 * Inbound webhook endpoints (architecture §11.1). Unauthenticated by nature:
 * the service verifies the provider signature over the raw body, so this scope
 * parses bodies as buffers.
 */
export const webhookRoutes: FastifyPluginAsync<{ notion: NotionWebhookService }> = async (
  app,
  opts,
) => {
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
  });
};
