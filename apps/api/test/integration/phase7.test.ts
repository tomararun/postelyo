import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  auditLogArchive,
  contentSource,
  post,
  socialAccount,
  webhookDelivery,
  webhookEndpoint,
} from '../../src/infra/db/schema.js';
import { envelopeKeyId } from '../../src/infra/crypto/envelope.js';
import { bodyToString, fakeFetch } from '../../src/shared/fetch-utils.js';
import { uuidv7 } from '../../src/shared/ids.js';
import { runMaintenance } from '../../src/jobs/maintenance.job.js';
import { runWebhookTick } from '../../src/jobs/webhook.job.js';
import { PLANS, planHas } from '../../src/modules/billing/plans.js';
import { RateLimiter } from '../../src/modules/enterprise/api-key.service.js';
import {
  WEBHOOK_CIRCUIT_FAILURES,
  WEBHOOK_MAX_ATTEMPTS,
  signWebhook,
  verifyWebhookSignature,
} from '../../src/modules/enterprise/webhook.service.js';
import { createFakeProviders } from './fake-providers.js';
import { FakeOidcProvider } from './fake-oidc.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';
import { pino } from 'pino';

const HOOKS = 'https://hooks.example.test';

describe('phase 7 public API, webhooks, enterprise security', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  const oidc = new FakeOidcProvider();
  const received: { url: string; headers: Record<string, string>; body: string }[] = [];
  const hookStatus = 200;
  const fetchImpl = fakeFetch(async (url, init) => {
    const fromIdp = await oidc.handle(url, init);
    if (fromIdp) return fromIdp;
    if (url.startsWith(HOOKS)) {
      received.push({
        url,
        headers: Object.fromEntries(
          Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        body: bodyToString(init.body),
      });
      return new Response(url.endsWith('/fail') ? 'nope' : 'ok', {
        status: url.endsWith('/fail') ? 500 : hookStatus,
      });
    }
    return fake.fetchImpl(url, init);
  });
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let apiSecret: string;
  let readOnlySecret: string;
  const logger = pino({ level: 'silent' });

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = { cookie },
  ) =>
    stack.app.inject({
      method,
      url,
      headers: {
        ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const apiCall = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extra: Record<string, string> = {},
    secret = apiSecret,
  ) => inject(method, url, payload, { authorization: `Bearer ${secret}`, ...extra });
  const sync = async () => {
    const res = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      {},
    );
    expect([200, 207]).toContain(res.statusCode);
  };
  const tick = () => runWebhookTick(stack.services.webhooks, `t-${Date.now()}`, logger);

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        NOTION_CLIENT_ID: 'notion-client',
        NOTION_CLIENT_SECRET: 'notion-secret',
        METRICS_TOKEN: 'metrics-secret-token-7777',
        REGION: 'eu',
      },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p7')));
    await stack.grantPlan(workspaceId, 'team');
    const start = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/content-sources/notion/connect`,
    );
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await inject('GET', `/oauth/notion/callback?code=notion-good&state=${state}`);
    sourceId = new URL(locationOf(cb), 'http://localhost').searchParams.get('source')!;
    const options = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
    );
    const parent = options.json<{ pages: { id: string }[] }>().pages[0]!.id;
    await inject('POST', `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`, {
      mode: 'create',
      parentPageId: parent,
    });
    const li = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
    );
    const liState = new URL(li.headers.location as string).searchParams.get('state')!;
    await inject('GET', `/oauth/linkedin/callback?code=good-code&state=${liState}`);
  });
  afterAll(async () => {
    await stack.close();
  });

  // --- Plans -------------------------------------------------------------------

  it('adds the Enterprise plan and per-plan features without changing existing limits', () => {
    expect(PLANS.enterprise.custom).toBe(true);
    expect(PLANS.team.limits.accounts).toBe(10);
    expect(planHas('free', 'publicApi')).toBe(false);
    expect(planHas('team', 'publicApi')).toBe(true);
    expect(planHas('team', 'sso')).toBe(false);
    expect(planHas('enterprise', 'sso')).toBe(true);
    expect(planHas('enterprise', 'tenantKeys')).toBe(true);
  });

  it('shows the deployment region on the workspace', async () => {
    const ws = await inject('GET', `/v1/workspaces/${workspaceId}`);
    expect(ws.json<{ region: string }>().region).toBe('eu');
  });

  // --- API keys ------------------------------------------------------------------

  it('gates API keys on the plan and returns the secret exactly once', async () => {
    const { workspaceId: freeWs, cookie: freeCookie } = await stack.signInWithWorkspace(
      uniqueEmail('p7-free'),
    );
    const denied = await inject(
      'POST',
      `/v1/workspaces/${freeWs}/api-keys`,
      { name: 'ci', scopes: ['read'] },
      { cookie: freeCookie },
    );
    expect(denied.statusCode).toBe(402);

    const created = await inject('POST', `/v1/workspaces/${workspaceId}/api-keys`, {
      name: 'zapier',
      scopes: ['read', 'write'],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ key: { id: string; prefix: string }; secret: string }>();
    expect(body.secret.startsWith('pk_live_')).toBe(true);
    expect(body.key.prefix).toBe(body.secret.slice(0, 12));
    apiSecret = body.secret;
    const ro = await inject('POST', `/v1/workspaces/${workspaceId}/api-keys`, {
      name: 'dashboard',
      scopes: ['read'],
    });
    readOnlySecret = ro.json<{ secret: string }>().secret;

    const page = await inject('GET', `/v1/workspaces/${workspaceId}/developers`);
    const dev = page.json<{
      apiKeys: { name: string; prefix: string }[];
      entitled: { publicApi: boolean };
      openapiUrl: string;
    }>();
    expect(dev.entitled.publicApi).toBe(true);
    expect(dev.apiKeys.map((k) => k.name).sort()).toEqual(['dashboard', 'zapier']);
    expect(JSON.stringify(dev)).not.toContain(apiSecret);
    expect(dev.openapiUrl).toBe('http://localhost/api/v1/openapi.json');
  });

  it('authenticates the public API with bearer keys, scopes and rate limits', async () => {
    const ws = await apiCall('GET', '/api/v1/workspace');
    expect(ws.statusCode).toBe(200);
    expect(ws.json<{ id: string; region: string }>().id).toBe(workspaceId);
    expect(ws.headers['x-ratelimit-limit']).toBe('60');
    expect(ws.headers['x-ratelimit-remaining']).toBeDefined();

    const bad = await apiCall('GET', '/api/v1/workspace', undefined, {}, 'pk_live_nope');
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('Bearer');
    const none = await stack.app.inject({ method: 'GET', url: '/api/v1/workspace' });
    expect(none.statusCode).toBe(401);

    const scoped = await apiCall(
      'POST',
      '/api/v1/webhooks',
      { url: `${HOOKS}/ok` },
      {},
      readOnlySecret,
    );
    expect(scoped.statusCode).toBe(403);
    expect(scoped.json<{ code: string }>().code).toBe('insufficient_scope');

    // Token bucket: 60 per minute per key, then 429 with Retry-After.
    const limiter = new RateLimiter(3, () => 1_000_000);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(true);
    expect(limiter.take('k').allowed).toBe(false);
    const keyId = (await stack.services.apiKeys.authenticate(apiSecret))!.id;
    for (let i = 0; i < 70; i += 1) stack.services.apiKeys.limiter.take(keyId);
    const limited = await apiCall('GET', '/api/v1/workspace');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    stack.services.apiKeys.limiter.reset();
  });

  it('lists posts, publications, campaigns, analytics and audit through the API', async () => {
    fake.notion.upsert('p7-post', {
      status: 'Scheduled',
      title: 'API visible post',
      platforms: ['LinkedIn'],
      publishDate: { start: new Date(stack.clock.now().getTime() + 3600_000).toISOString() },
      body: ['hello api'],
    });
    await sync();
    const posts = await apiCall('GET', '/api/v1/posts?state=scheduled');
    expect(posts.statusCode).toBe(200);
    const list = posts.json<{
      posts: { id: string; title: string; publications: { id: string }[] }[];
    }>().posts;
    const mine = list.find((p) => p.title === 'API visible post')!;
    expect(mine).toBeDefined();
    const one = await apiCall('GET', `/api/v1/posts/${mine.id}`);
    expect(one.json<{ title: string }>().title).toBe('API visible post');
    const pub = await apiCall('GET', `/api/v1/publications/${mine.publications[0]!.id}`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json<{ state: string }>().state).toBe('scheduled');
    expect(JSON.stringify(pub.json())).not.toMatch(/access_token|AQV-access/);
    const retry = await apiCall('POST', `/api/v1/publications/${mine.publications[0]!.id}/retry`);
    expect(retry.statusCode).toBe(409);
    const campaigns = await apiCall('GET', '/api/v1/campaigns');
    expect(campaigns.statusCode).toBe(200);
    const analytics = await apiCall('GET', '/api/v1/analytics/summary?weeks=4');
    expect(analytics.statusCode).toBe(200);
    const audit = await apiCall('GET', '/api/v1/audit?event=api_key.created&limit=10');
    const events = audit.json<{ events: { event: string; actor: { type: string } }[] }>().events;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.event === 'api_key.created')).toBe(true);
    const missing = await apiCall('GET', `/api/v1/posts/${uuidv7()}`);
    expect(missing.statusCode).toBe(404);
  });

  it('creates posts as Notion pages with Idempotency-Key replay and mismatch detection', async () => {
    const before = fake.notion.createdPages.length;
    const body = {
      title: 'Created through the API',
      body: 'First paragraph.\n\nSecond paragraph.',
      platforms: ['LinkedIn'],
      status: 'Draft',
      note: 'from zapier',
    };
    const first = await apiCall('POST', '/api/v1/posts', body, { 'idempotency-key': 'zap-1' });
    expect(first.statusCode).toBe(201);
    const created = first.json<{ notionPageId: string; status: string }>();
    expect(created.status).toBe('Draft');
    expect(fake.notion.createdPages.length).toBe(before + 1);
    const page = fake.notion.pages.get(created.notionPageId)!;
    expect(page.title).toBe('Created through the API');
    expect(fake.notion.bodyOf(page.id)).toContain('Second paragraph.');
    expect(page.system.postelyoNote).toBe('from zapier');

    const replay = await apiCall('POST', '/api/v1/posts', body, { 'idempotency-key': 'zap-1' });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json<{ notionPageId: string }>().notionPageId).toBe(created.notionPageId);
    expect(fake.notion.createdPages.length).toBe(before + 1);

    const mismatch = await apiCall(
      'POST',
      '/api/v1/posts',
      { ...body, title: 'Different' },
      { 'idempotency-key': 'zap-1' },
    );
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json<{ code: string }>().code).toBe('idempotency_mismatch');

    // The sync picks the page up as a draft post of this workspace.
    await sync();
    const [row] = await stack.db.db
      .select()
      .from(post)
      .where(and(eq(post.externalId, page.id), eq(post.workspaceId, workspaceId)));
    expect(row?.state).toBe('draft');

    // Expired replay records are pruned by maintenance.
    stack.clock.advance(25 * 3600_000);
    expect(await stack.services.apiKeys.pruneIdempotency()).toBeGreaterThanOrEqual(1);
    stack.clock.advance(-25 * 3600_000);
  });

  it('publishes an OpenAPI document that matches the registered routes', async () => {
    const res = await stack.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json<{
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      servers: { url: string }[];
    }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]!.url).toBe('http://localhost/api/v1');
    for (const [path, ops] of Object.entries(doc.paths)) {
      const url = '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1');
      for (const method of Object.keys(ops)) {
        expect(
          stack.app.hasRoute({ method: method.toUpperCase(), url }),
          `${method.toUpperCase()} ${url}`,
        ).toBe(true);
      }
    }
    expect(Object.keys(doc.paths)).toContain('/posts');
    expect(Object.keys(doc.paths)).toContain('/webhooks/{endpointId}/test');
  });

  // --- Webhooks ------------------------------------------------------------------

  it('signs and verifies webhook payloads', () => {
    const sig = signWebhook('whsec_x', 1_700_000_000, '{"a":1}');
    expect(sig).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(verifyWebhookSignature('whsec_x', sig, '{"a":1}', 300, 1_700_000_100)).toBe(true);
    expect(verifyWebhookSignature('whsec_x', sig, '{"a":2}', 300, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature('whsec_y', sig, '{"a":1}', 300, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature('whsec_x', sig, '{"a":1}', 300, 1_700_009_000)).toBe(false);
  });

  it('delivers subscribed audit events with a signature, from the subscription onwards', async () => {
    const created = await apiCall(
      'POST',
      '/api/v1/webhooks',
      { url: `${HOOKS}/ok`, events: ['post.created', 'post.state_changed', 'webhook.test'] },
      {},
    );
    expect(created.statusCode).toBe(400); // webhook.test is not a subscribable event
    const ok = await apiCall('POST', '/api/v1/webhooks', {
      url: `${HOOKS}/ok`,
      description: 'Zapier',
      events: ['post.created', 'post.state_changed'],
    });
    expect(ok.statusCode).toBe(201);
    const { endpoint, secret } = ok.json<{ endpoint: { id: string }; secret: string }>();
    expect(secret.startsWith('whsec_')).toBe(true);
    const listed = await apiCall('GET', '/api/v1/webhooks');
    expect(JSON.stringify(listed.json())).not.toContain(secret);

    // Nothing from before the subscription is replayed.
    await tick();
    expect(received.filter((r) => r.url === `${HOOKS}/ok`)).toHaveLength(0);

    fake.notion.upsert('p7-hook', {
      status: 'Draft',
      title: 'Hooked post',
      platforms: ['LinkedIn'],
      body: ['hook me'],
    });
    await sync();
    await tick();
    const posted = received.filter((r) => r.url === `${HOOKS}/ok`);
    expect(posted.length).toBeGreaterThanOrEqual(1);
    const first = posted[0]!;
    expect(first.headers['x-postelyo-event']).toBe('post.created');
    expect(first.headers['x-postelyo-delivery']).toBeDefined();
    expect(
      verifyWebhookSignature(
        secret,
        first.headers['x-postelyo-signature']!,
        first.body,
        600,
        Math.floor(stack.clock.now().getTime() / 1000),
      ),
    ).toBe(true);
    const payload = JSON.parse(first.body) as {
      event: string;
      workspaceId: string;
      entityType: string;
      data: unknown;
    };
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.entityType).toBe('post');
    expect(first.body).not.toMatch(/AQV-access|ntn_/);

    const deliveries = await apiCall('GET', `/api/v1/webhooks/${endpoint.id}/deliveries`);
    const rows = deliveries.json<{
      deliveries: { status: string; event: string; attempts: number }[];
    }>().deliveries;
    expect(rows.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
    expect(rows.some((d) => d.event === 'post.created')).toBe(true);
    // Unsubscribed events (api_key.created etc.) were not delivered.
    expect(rows.every((d) => ['post.created', 'post.state_changed'].includes(d.event))).toBe(true);

    // A second tick sends nothing new; the cursor moved.
    const n = received.length;
    await tick();
    expect(received.length).toBe(n);

    const test = await apiCall('POST', `/api/v1/webhooks/${endpoint.id}/test`);
    expect(test.statusCode).toBe(200);
    expect(test.json<{ status: string; event: string }>()).toMatchObject({
      status: 'delivered',
      event: 'webhook.test',
    });
    const del = await apiCall('DELETE', `/api/v1/webhooks/${endpoint.id}`);
    expect(del.statusCode).toBe(200);
  });

  it('retries with backoff, gives up after the attempt budget and trips the circuit breaker', async () => {
    const res = await inject('POST', `/v1/workspaces/${workspaceId}/webhooks`, {
      url: `${HOOKS}/fail`,
      events: ['post.archived'],
    });
    expect(res.statusCode).toBe(201);
    const { endpoint } = res.json<{ endpoint: { id: string } }>();
    const sent = stack.mailer.sent.length;
    // Two test deliveries: attempts are counted per delivery, failures per endpoint.
    const t1 = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/webhooks/${endpoint.id}/test`,
      {},
    );
    expect(
      t1.json<{
        status: string;
        attempts: number;
        lastStatusCode: number;
        nextAttemptAt: string;
      }>(),
    ).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500 });
    expect(t1.json<{ nextAttemptAt: string }>().nextAttemptAt).toBeDefined();
    // One delivery burns its whole attempt budget (8) and dies; the endpoint counts every failure.
    for (let round = 0; round < 10; round += 1) {
      stack.clock.advance(25 * 3600_000);
      await stack.services.webhooks.deliverDue(`bo-${round}`);
    }
    const [dead] = await stack.db.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.endpointId, endpoint.id));
    expect(dead).toMatchObject({ status: 'dead', attempts: WEBHOOK_MAX_ATTEMPTS });
    let [epMid] = await stack.db.db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, endpoint.id));
    expect(epMid!.consecutiveFailures).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(epMid!.enabled).toBe(true);
    // Two more failures trip the breaker at ten.
    await inject('POST', `/v1/workspaces/${workspaceId}/webhooks/${endpoint.id}/test`, {});
    [epMid] = await stack.db.db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, endpoint.id));
    expect(epMid!.consecutiveFailures).toBe(WEBHOOK_CIRCUIT_FAILURES - 1);
    stack.clock.advance(25 * 3600_000);
    await stack.services.webhooks.deliverDue('bo-trip');
    const [ep] = await stack.db.db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, endpoint.id));
    expect(ep!.enabled).toBe(false);
    expect(ep!.disabledReason).toContain('consecutive failures');
    expect(ep!.consecutiveFailures).toBeGreaterThanOrEqual(WEBHOOK_CIRCUIT_FAILURES);
    const dels = await stack.db.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.endpointId, endpoint.id));
    expect(dels.every((d) => d.attempts <= WEBHOOK_MAX_ATTEMPTS)).toBe(true);
    expect(dels.some((d) => d.status === 'dead')).toBe(true);
    const [audit] = await stack.db.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, endpoint.id), eq(auditLog.event, 'webhook.endpoint_disabled')),
      );
    expect(audit).toBeDefined();
    expect(stack.mailer.sent.length).toBeGreaterThan(sent);
    expect(stack.mailer.sent.at(-1)!.subject).toContain('webhook');
    // Re-enabling resets the breaker.
    const patched = await inject('PATCH', `/v1/workspaces/${workspaceId}/webhooks/${endpoint.id}`, {
      enabled: true,
    });
    expect(patched.json<{ enabled: boolean; consecutiveFailures: number }>()).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
    });
    const other = await stack.signInWithWorkspace(uniqueEmail('p7-other'));
    const foreign = await inject(
      'DELETE',
      `/v1/workspaces/${other.workspaceId}/webhooks/${endpoint.id}`,
      undefined,
      { cookie: other.cookie },
    );
    expect(foreign.statusCode).toBe(404);
  });

  // --- Audit export and archive ------------------------------------------------

  it('exports the audit trail as NDJSON and archives old rows', async () => {
    // Audit rows carry database time, not the test clock.
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const res = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/audit/export?from=${from}&to=${to}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; actor: { type: string } });
    expect(lines.some((l) => l.event === 'api_key.created')).toBe(true);
    expect(lines.some((l) => l.actor.type === 'api_key')).toBe(true);
    expect(res.body).not.toMatch(/pk_live_[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9_-]{20,}/);
    const viaApi = await apiCall('GET', `/api/v1/audit/export?from=${from}&to=${to}`);
    expect(viaApi.statusCode).toBe(200);
    expect(viaApi.body.split('\n').length).toBeGreaterThanOrEqual(lines.length);
    const bad = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/audit/export?from=${to}&to=${from}`,
    );
    expect(bad.statusCode).toBe(400);
    const exported = await stack.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.event, 'audit.exported')));
    expect(exported.length).toBeGreaterThanOrEqual(2);

    // A 14-month-old row moves to the archive and still exports.
    const old = new Date(stack.clock.now().getTime() - 14 * 30 * 24 * 3600_000);
    const oldId = uuidv7(old.getTime());
    await stack.db.db.insert(auditLog).values({
      id: oldId,
      workspaceId,
      occurredAt: old,
      actorType: 'system',
      actorId: 'test',
      entityType: 'post',
      entityId: 'ancient',
      event: 'post.created',
      data: {},
    });
    const moved = await stack.services.auditArchive.archive('arch-1');
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(await stack.db.db.select().from(auditLog).where(eq(auditLog.id, oldId))).toHaveLength(0);
    const [archived] = await stack.db.db
      .select()
      .from(auditLogArchive)
      .where(eq(auditLogArchive.id, oldId));
    expect(archived?.entityId).toBe('ancient');
    const oldExport = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/audit/export?from=${new Date(old.getTime() - 86_400_000).toISOString()}&to=${new Date(old.getTime() + 86_400_000).toISOString()}`,
    );
    expect(oldExport.body).toContain('"ancient"');
  });

  // --- Tenant keys ---------------------------------------------------------------

  it('enables and rotates per-tenant keys, re-sealing every credential', async () => {
    const denied = await inject('POST', `/v1/workspaces/${workspaceId}/tenant-keys/enable`, {});
    expect(denied.statusCode).toBe(402);
    await stack.grantPlan(workspaceId, 'enterprise');
    const accountsBefore = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.workspaceId, workspaceId));
    expect(accountsBefore.length).toBeGreaterThanOrEqual(1);
    expect(envelopeKeyId(accountsBefore[0]!.accessTokenEnc!)).toBe('k1');

    const enabled = await inject('POST', `/v1/workspaces/${workspaceId}/tenant-keys/enable`, {});
    expect(enabled.statusCode).toBe(200);
    const status = enabled.json<{
      enabled: boolean;
      version: number;
      credentials: { total: number; onCurrentKey: number };
    }>();
    expect(status).toMatchObject({ enabled: true, version: 1 });
    expect(status.credentials.total).toBeGreaterThanOrEqual(2);
    expect(status.credentials.onCurrentKey).toBe(status.credentials.total);
    const [acc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, accountsBefore[0]!.id));
    expect(acc!.credentialKeyId).toBe('t1');
    expect(envelopeKeyId(acc!.accessTokenEnc!)).toBe('t1');
    const [src] = await stack.db.db
      .select()
      .from(contentSource)
      .where(eq(contentSource.id, sourceId));
    expect(envelopeKeyId(src!.credentialEnc!)).toBe('t1');
    const ctx = {
      workspaceId,
      actor: { type: 'system' as const, id: 'test' },
      correlationId: 'tk',
    };
    const plain = await stack.services.vault.withCredential(
      ctx,
      { entityType: 'social_account', entityId: acc!.id, column: 'access_token' },
      acc!.accessTokenEnc!,
      'publish',
      async (t) => t,
    );
    expect(plain).toBe('AQV-access-good-code');
    // The master key alone can no longer open the blob.
    const { open } = await import('../../src/infra/crypto/envelope.js');
    expect(() =>
      open(stack.keyProvider, acc!.accessTokenEnc!, `social_account.access_token:${acc!.id}`),
    ).toThrow();

    const again = await inject('POST', `/v1/workspaces/${workspaceId}/tenant-keys/enable`, {});
    expect(again.statusCode).toBe(409);
    const rotated = await inject('POST', `/v1/workspaces/${workspaceId}/tenant-keys/rotate`, {});
    expect(rotated.json<{ version: number }>().version).toBe(2);
    const [acc2] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, acc!.id));
    expect(envelopeKeyId(acc2!.accessTokenEnc!)).toBe('t2');
    expect(
      await stack.services.vault.withCredential(
        ctx,
        { entityType: 'social_account', entityId: acc!.id, column: 'access_token' },
        acc2!.accessTokenEnc!,
        'publish',
        async (t) => t,
      ),
    ).toBe('AQV-access-good-code');
    // New credentials are sealed under the tenant key directly.
    const li = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
    );
    const liState = new URL(li.headers.location as string).searchParams.get('state')!;
    await inject('GET', `/oauth/linkedin/callback?code=good-code-2&state=${liState}`);
    const accounts = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.workspaceId, workspaceId));
    expect(accounts.every((a) => a.credentialKeyId === 't2')).toBe(true);
    // Sync still works with the re-sealed Notion token.
    await sync();
    const sec = await inject('GET', `/v1/workspaces/${workspaceId}/security`);
    expect(
      sec.json<{ tenantKeys: { version: number }; region: string; entitled: { sso: boolean } }>(),
    ).toMatchObject({ tenantKeys: { version: 2 }, region: 'eu', entitled: { sso: true } });
  });

  // --- SSO -----------------------------------------------------------------------

  it('signs users in through OIDC with PKCE, nonce and domain checks', async () => {
    const domain = `acme-${Date.now().toString(36)}.test`;
    oidc.subject = { email: `alice@${domain}`, name: 'Alice Acme', sub: 'alice' };
    const put = await inject('PUT', `/v1/workspaces/${workspaceId}/sso`, {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      emailDomain: domain,
      defaultRole: 'editor',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ emailDomain: string; defaultRole: string }>()).toMatchObject({
      emailDomain: domain,
      defaultRole: 'editor',
    });
    expect(JSON.stringify(put.json())).not.toContain(oidc.clientSecret);
    const lookup = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/lookup?email=bob@${domain}`,
    });
    expect(lookup.json<{ sso: boolean }>().sso).toBe(true);
    expect(
      (
        await stack.app.inject({ method: 'GET', url: '/api/auth/sso/lookup?email=x@nowhere.test' })
      ).json<{ sso: boolean }>().sso,
    ).toBe(false);

    const start = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/start?email=alice@${domain}&next=${encodeURIComponent(`/w/${workspaceId}/posts`)}`,
    });
    expect(start.statusCode).toBe(302);
    const authz = new URL(start.headers.location as string);
    expect(authz.origin + authz.pathname).toBe(`${oidc.issuer}/authorize`);
    expect(authz.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authz.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/sso/callback');
    const state = authz.searchParams.get('state')!;
    oidc.nextNonce = authz.searchParams.get('nonce')!;

    const cb = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/callback?code=good-code&state=${state}`,
    });
    expect(cb.statusCode).toBe(302);
    const verify = cb.headers.location as string;
    expect(verify).toContain('/api/auth/magic-link/verify');
    expect(oidc.tokenRequests.at(-1)!['code_verifier']).toBeDefined();
    const verified = await stack.app.inject({ method: 'GET', url: verify });
    expect(verified.statusCode).toBe(302);
    const setCookie = verified.headers['set-cookie'];
    const ssoCookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .map((c) => (c ?? '').split(';')[0])
      .join('; ');
    const completeUrl = new URL(verified.headers.location as string, 'http://localhost');
    expect(completeUrl.pathname).toBe('/api/auth/sso/complete');
    const complete = await stack.app.inject({
      method: 'GET',
      url: completeUrl.pathname + completeUrl.search,
      headers: { cookie: ssoCookie },
    });
    expect(complete.statusCode).toBe(302);
    expect(complete.headers.location).toBe(`/w/${workspaceId}/posts`);
    const me = await stack.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: ssoCookie },
    });
    const meBody = me.json<{
      user: { email: string };
      workspaces: { id: string; role: string }[];
    }>();
    expect(meBody.user.email).toBe(`alice@${domain}`);
    expect(meBody.workspaces.find((w) => w.id === workspaceId)?.role).toBe('editor');
    const signedIn = await stack.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.event, 'sso.signed_in')));
    expect(signedIn).toHaveLength(1);

    // Replaying the state fails; a foreign-domain identity is refused.
    const replay = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/callback?code=good-code&state=${state}`,
    });
    expect(decodeURIComponent(replay.headers.location as string)).toContain(
      'expired or was already used',
    );
    oidc.subject = { email: 'mallory@other.test', name: 'Mallory', sub: 'mallory' };
    const start2 = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/start?email=bob@${domain}`,
    });
    const authz2 = new URL(start2.headers.location as string);
    oidc.nextNonce = authz2.searchParams.get('nonce')!;
    const cb2 = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/callback?code=good-code&state=${authz2.searchParams.get('state')}`,
    });
    expect(decodeURIComponent(cb2.headers.location as string)).toContain(`Only ${domain} accounts`);
    // Wrong nonce (token replay from another session) is rejected too.
    const start3 = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/start?email=bob@${domain}`,
    });
    oidc.subject = { email: `bob@${domain}`, name: 'Bob', sub: 'bob' };
    oidc.nextNonce = 'stale';
    const cb3 = await stack.app.inject({
      method: 'GET',
      url: `/api/auth/sso/callback?code=good-code&state=${new URL(start3.headers.location as string).searchParams.get('state')}`,
    });
    expect(decodeURIComponent(cb3.headers.location as string)).toContain('Nonce mismatch');
    // A workspace without the entitlement cannot configure SSO.
    const { workspaceId: teamWs, cookie: teamCookie } = await stack.signInWithWorkspace(
      uniqueEmail('p7-team'),
    );
    await stack.grantPlan(teamWs, 'team');
    const deniedSso = await inject(
      'PUT',
      `/v1/workspaces/${teamWs}/sso`,
      { issuer: oidc.issuer, clientId: 'x', clientSecret: 'y', emailDomain: 'team-only.test' },
      { cookie: teamCookie },
    );
    expect(deniedSso.statusCode).toBe(402);
  });

  // --- Ops -------------------------------------------------------------------

  it('exposes queue gauges and runs the Phase 7 maintenance steps', async () => {
    const metrics = await stack.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret-token-7777' },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('# TYPE postelyo_queue_jobs gauge');
    expect(metrics.body).toMatch(/postelyo_queue_available [01]/);
    expect(await stack.services.queueHealth.check(stack.services.alerts, 'qh')).toEqual([]);
    await runMaintenance(
      {
        reconciliation: stack.services.reconciliation,
        alerts: stack.services.alerts,
        tokenExpiry: stack.services.tokenExpiry,
        digest: stack.services.digest,
        heartbeat: stack.services.heartbeat,
        notionWebhooks: stack.services.notionWebhooks,
        media: stack.services.media,
        billing: stack.services.billing,
        apiKeys: stack.services.apiKeys,
        auditArchive: stack.services.auditArchive,
        queueHealth: stack.services.queueHealth,
      },
      'maint-p7',
      logger,
    );
  });
});
