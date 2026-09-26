import type { FastifyPluginAsync } from 'fastify';

export type ReadinessCheck = () => Promise<{ db: boolean }>;

export const healthRoutes: FastifyPluginAsync<{ readiness: ReadinessCheck }> = async (
  app,
  opts,
) => {
  app.get('/health/live', { logLevel: 'silent' }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { logLevel: 'silent' }, async (_req, reply) => {
    try {
      const checks = await opts.readiness();
      const ok = Object.values(checks).every(Boolean);
      return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'degraded', checks: { db: false } });
    }
  });
};
