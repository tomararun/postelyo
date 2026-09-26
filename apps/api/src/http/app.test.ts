import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { buildApp } from './app.js';

const logger = pino({ level: 'silent' });

describe('http app', () => {
  it('reports liveness', async () => {
    const app = await buildApp({ logger, readiness: async () => ({ db: true }) });
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('reports readiness from the injected check', async () => {
    const app = await buildApp({ logger, readiness: async () => ({ db: false }) });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { db: false } });
    await app.close();
  });

  it('turns a throwing readiness check into 503, not 500', async () => {
    const app = await buildApp({
      logger,
      readiness: async () => {
        throw new Error('db down');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('renders unknown routes as problem+json', async () => {
    const app = await buildApp({ logger, readiness: async () => ({ db: true }) });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 404, instance: '/nope' });
    await app.close();
  });

  it('echoes x-request-id', async () => {
    const app = await buildApp({ logger, readiness: async () => ({ db: true }) });
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'abc' },
    });
    expect(res.headers['x-request-id']).toBe('abc');
    await app.close();
  });
});
