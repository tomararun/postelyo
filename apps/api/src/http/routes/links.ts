import type { FastifyPluginAsync } from 'fastify';
import type { LinkService } from '../../modules/links/link.service.js';

/**
 * Phase 4 short links: `/l/{code}` redirects to the tracked target and counts
 * the click. Public by nature; codes are random and carry no tenant data.
 */
export const linkRoutes: FastifyPluginAsync<{ links: LinkService }> = async (app, opts) => {
  app.get('/l/:code', { logLevel: 'silent' }, async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(code)) return reply.status(404).send();
    const target = await opts.links.resolve(code);
    if (!target) return reply.status(404).send();
    return reply.header('cache-control', 'no-store').redirect(target, 302);
  });
};
