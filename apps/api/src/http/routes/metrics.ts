import type { FastifyPluginAsync } from 'fastify';
import type { MetricsService } from '../../modules/ops/metrics.service.js';

export interface MetricsRoutesOptions {
  metrics: MetricsService;
  /** When set, callers must send `Authorization: Bearer <token>`. */
  token: string | null;
}

/** Prometheus scrape endpoint (architecture §19). */
export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (app, opts) => {
  app.get('/metrics', { logLevel: 'silent' }, async (req, reply) => {
    if (opts.token) {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${opts.token}`) {
        return reply.status(401).type('text/plain').send('unauthorized\n');
      }
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(await opts.metrics.render());
  });
};
