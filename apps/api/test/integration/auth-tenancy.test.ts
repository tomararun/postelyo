import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog } from '../../src/infra/db/schema.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

describe('identity and tenancy', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await createTestStack();
  });
  afterAll(async () => {
    await stack.close();
  });

  it('rejects anonymous api access with 401 and redirects pages to sign-in', async () => {
    expect((await stack.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const home = await stack.app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(302);
    expect(home.headers.location).toBe('/sign-in');
  });

  it('signs in via magic link and provisions a default workspace with an owner membership', async () => {
    const email = uniqueEmail('alice');
    const cookie = await stack.signIn(email);

    const me = await stack.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      user: { email: string };
      workspaces: { id: string; role: string; slug: string }[];
    }>();
    expect(body.user.email).toBe(email);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.role).toBe('owner');

    const wsId = body.workspaces[0]!.id;
    const events = await stack.db.db
      .select({ event: auditLog.event, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, wsId));
    expect(events.map((e) => e.event).sort()).toEqual(['membership.created', 'workspace.created']);

    // Second sign-in does not create another workspace.
    const cookie2 = await stack.signIn(email);
    const me2 = await stack.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: cookie2 },
    });
    expect(me2.json<{ workspaces: unknown[] }>().workspaces).toHaveLength(1);
  });

  it('serves the sign-in form and accepts a form post', async () => {
    const page = await stack.app.inject({ method: 'GET', url: '/sign-in' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post" action="/sign-in">');

    const email = uniqueEmail('form');
    const post = await stack.app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
      payload: `email=${encodeURIComponent(email)}`,
    });
    expect(post.statusCode).toBe(302);
    expect(post.headers.location).toBe(`/sign-in?sent=${encodeURIComponent(email)}`);
    expect(stack.mailer.lastTo(email)?.text).toMatch(/\/api\/auth\/magic-link\/verify\?token=/);

    const invalid = await stack.app.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
      payload: 'email=not-an-email',
    });
    expect(invalid.statusCode).toBe(302);
    expect(invalid.headers.location).toMatch(/^\/sign-in\?error=/);
  });

  it('renders the home page for a signed-in user', async () => {
    const cookie = await stack.signIn(uniqueEmail('page'));
    const home = await stack.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(home.statusCode).toBe(200);
    expect(home.headers['content-type']).toContain('text/html');
    expect(home.body).toContain('Your workspaces');
    expect(home.body).toContain('owner');
  });

  it('reads and updates workspace settings with validation and audit', async () => {
    const cookie = await stack.signIn(uniqueEmail('owner'));
    const me = await stack.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    const wsId = me.json<{ workspaces: { id: string }[] }>().workspaces[0]!.id;

    const get = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      id: wsId,
      defaultTimezone: 'UTC',
      defaultPublishTime: '09:00',
    });

    const bad = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${wsId}`,
      headers: { cookie },
      payload: { defaultTimezone: 'Mars/Olympus', defaultPublishTime: '25:00' },
    });
    expect(bad.statusCode).toBe(422);
    expect(
      bad
        .json<{ issues: { path: string }[] }>()
        .issues.map((i) => i.path)
        .sort(),
    ).toEqual(['defaultPublishTime', 'defaultTimezone']);

    const unknownField = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${wsId}`,
      headers: { cookie },
      payload: { plan: 'enterprise' },
    });
    expect(unknownField.statusCode).toBe(400);

    const ok = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${wsId}`,
      headers: { cookie },
      payload: { name: 'Acme', defaultTimezone: 'Europe/Berlin', defaultPublishTime: '10:30' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      name: 'Acme',
      defaultTimezone: 'Europe/Berlin',
      defaultPublishTime: '10:30',
    });

    const updated = await stack.db.db
      .select({ data: auditLog.data, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.event, 'workspace.updated'));
    const mine = updated.find((r) => JSON.stringify(r.data).includes('Europe/Berlin'));
    expect(mine).toBeDefined();
    expect(mine?.data).toMatchObject({
      changed: { defaultTimezone: { from: 'UTC', to: 'Europe/Berlin' } },
    });
  });

  it('isolates tenants: another user gets 404 for a workspace they do not belong to', async () => {
    const cookieA = await stack.signIn(uniqueEmail('a'));
    const cookieB = await stack.signIn(uniqueEmail('b'));
    const meA = await stack.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: cookieA },
    });
    const wsA = meA.json<{ workspaces: { id: string }[] }>().workspaces[0]!.id;

    for (const method of ['GET', 'PATCH'] as const) {
      const res = await stack.app.inject({
        method,
        url: `/v1/workspaces/${wsA}`,
        headers: { cookie: cookieB },
        ...(method === 'PATCH' ? { payload: { name: 'pwned' } } : {}),
      });
      expect(res.statusCode, `${method} cross-tenant`).toBe(404);
    }
    const bogus = await stack.app.inject({
      method: 'GET',
      url: '/v1/workspaces/not-a-uuid',
      headers: { cookie: cookieB },
    });
    expect(bogus.statusCode).toBe(404);

    // Owner still sees the original name; B's PATCH did nothing.
    const check = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${wsA}`,
      headers: { cookie: cookieA },
    });
    expect(check.json<{ name: string }>().name).not.toBe('pwned');
  });

  it('rejects cross-origin form posts and signs out', async () => {
    const cookie = await stack.signIn(uniqueEmail('out'));
    const cross = await stack.app.inject({
      method: 'POST',
      url: '/sign-out',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(cross.statusCode).toBe(403);

    const out = await stack.app.inject({
      method: 'POST',
      url: '/sign-out',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(out.statusCode).toBe(302);
    const after = await stack.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('magic link tokens are single-use', async () => {
    const email = uniqueEmail('once');
    await stack.signIn(email);
    const link = stack.mailer.lastTo(email)!.text.match(/https?:\/\/\S+/)![0];
    const again = await stack.app.inject({
      method: 'GET',
      url: new URL(link).pathname + new URL(link).search,
    });
    const setCookie = again.headers['set-cookie'];
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).find((c) =>
      c.includes('session_token='),
    );
    // Either an error redirect or no fresh session cookie; never a second session.
    expect(sessionCookie === undefined || /session_token=;/.test(sessionCookie)).toBe(true);
  });
});
