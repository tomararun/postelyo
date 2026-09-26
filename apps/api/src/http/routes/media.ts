import type { FastifyPluginAsync } from 'fastify';
import { assertStorageKey, type ObjectStorage } from '../../infra/storage/index.js';

/**
 * Serves stored media for the local storage driver (Phase 2). Keys are content
 * hashes inside a workspace prefix: unguessable, not secret. Providers fetch
 * these URLs once at publish time; with the S3 driver this route answers 404.
 */
export const mediaRoutes: FastifyPluginAsync<{ storage: ObjectStorage }> = async (app, opts) => {
  app.get('/media/*', { logLevel: 'silent' }, async (req, reply) => {
    if (opts.storage.driver !== 'local') return reply.status(404).send();
    const key = (req.params as { '*': string })['*'];
    let safe: string;
    try {
      safe = assertStorageKey(key);
    } catch {
      return reply.status(404).send();
    }
    const found = await opts.storage.get(safe);
    if (!found) return reply.status(404).send();
    return reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type(found.contentType)
      .send(Buffer.from(found.bytes));
  });
};
