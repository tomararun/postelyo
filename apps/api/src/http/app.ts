import Fastify, { type FastifyError } from 'fastify';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../infra/logger.js';
import { reportError } from '../infra/sentry.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';

export interface AppDeps {
  logger: Logger;
  readiness: ReadinessCheck;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

/** RFC 9457 problem details body (architecture §14.1). */
function problem(status: number, title: string, instance: string, code?: string) {
  return { type: 'about:blank', title, status, instance, ...(code ? { code } : {}) };
}

/** Builds the HTTP app without listening, so tests can use `app.inject`. */
export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);
  await app.register(healthRoutes, { readiness: deps.readiness });

  app.setNotFoundHandler(async (req, reply) => {
    return reply
      .status(404)
      .type('application/problem+json')
      .send(problem(404, 'Not Found', req.url));
  });

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      reportError(err, { route: req.routeOptions.url ?? req.url, requestId: req.id });
    }
    return reply
      .status(status)
      .type('application/problem+json')
      .send(
        problem(
          status,
          status >= 500 ? 'Internal Server Error' : err.message,
          req.url,
          status < 500 ? err.code : undefined,
        ),
      );
  });

  return app;
}
