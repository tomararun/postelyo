import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

/** D67: the on-screen sign-in link exists only in local development with log-only mail. */
describe('development sign-in link', () => {
  let dev: TestStack;
  let normal: TestStack;

  beforeAll(async () => {
    dev = await createTestStack({ env: { NODE_ENV: 'development', MAIL_TRANSPORT: 'log' } });
    normal = await createTestStack();
  });
  afterAll(async () => {
    await dev.close();
    await normal.close();
  });

  it('returns the latest link sent to an address in development', async () => {
    const email = uniqueEmail('dev-link');
    const start = await dev.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      payload: { email, callbackURL: '/workspaces' },
    });
    expect(start.statusCode).toBe(200);
    const res = await dev.app.inject({
      method: 'GET',
      url: `/v1/dev/magic-link?email=${encodeURIComponent(email.toUpperCase())}`,
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json<{ url: string }>();
    expect(url).toContain('/api/auth/magic-link/verify?token=');
    // The link works and signs the user in.
    const verify = await dev.app.inject({
      method: 'GET',
      url: new URL(url).pathname + new URL(url).search,
    });
    expect(verify.headers['set-cookie']).toBeDefined();
    const unknown = await dev.app.inject({
      method: 'GET',
      url: '/v1/dev/magic-link?email=nobody@example.com',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('does not exist outside development', async () => {
    const res = await normal.app.inject({
      method: 'GET',
      url: '/v1/dev/magic-link?email=x@example.com',
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('url');
  });
});
