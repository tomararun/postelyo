import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { pino } from 'pino';
import {
  auditLog,
  contentSource,
  invitation,
  membership,
  publication,
  socialAccount,
  stripeEvent,
  subscription,
  workspace,
} from '../../src/infra/db/schema.js';
import { runMaintenance } from '../../src/jobs/maintenance.job.js';
import { recordAudit } from '../../src/modules/audit/audit.js';
import { GRACE_PERIOD_MS, PLANS } from '../../src/modules/billing/plans.js';
import { FakeBillingGateway } from '../../src/modules/billing/gateway.js';
import { NOTION_GOOD_DB, NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

const STRIPE_WEBHOOK_SECRET = 'whsec_test_phase3_secret';
const PRICES = { solo: 'price_solo', team: 'price_team', agency: 'price_agency' };

/**
 * Phase 3 self-serve SaaS: Notion OAuth onboarding, teams, Stripe billing and
 * plan limits, notification overrides, workspace deletion and legal pages.
 * Stripe is never called: the FakeBillingGateway records checkouts and the
 * webhook is exercised with locally signed events.
 */
describe('phase 3 self-serve', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  const gateway = new FakeBillingGateway();
  let ownerCookie: string;
  let ownerEmail: string;
  let workspaceId: string;
  let eventSeq = 0;

  const inject = (
    cookie: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    stack.app.inject({
      method,
      url,
      headers: { cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const me = async (cookie: string) =>
    (await inject(cookie, 'GET', '/v1/me')).json<{
      user: { id: string; email: string };
      workspaces: { id: string; role: string }[];
    }>();

  const stripeEventBody = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({
      id: `evt_${++eventSeq}_${Date.now().toString(36)}`,
      object: 'event',
      api_version: '2025-08-27.basil',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type,
      data: { object },
    });

  const postStripe = async (payload: string, secret = STRIPE_WEBHOOK_SECRET) =>
    stack.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      },
      payload,
    });

  const subscriptionObject = (
    id: string,
    customer: string,
    price: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    object: 'subscription',
    customer,
    status,
    metadata: { workspaceId },
    cancel_at: null,
    items: {
      object: 'list',
      data: [
        {
          id: `si_${id}`,
          object: 'subscription_item',
          price: { id: price, object: 'price' },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      ],
    },
    ...extra,
  });

  const usage = async (cookie = ownerCookie, ws = workspaceId) =>
    (await inject(cookie, 'GET', `/v1/workspaces/${ws}/billing`)).json<{
      plan: string;
      limits: { accounts: number; postsPerMonth: number; members: number | null };
      used: { accounts: number; postsThisMonth: number; members: number };
      subscription: { status: string; graceUntil: string | null } | null;
      billingConfigured: boolean;
      availablePlans: { id: string }[];
    }>();

  const linkedInFlow = async (cookie: string, ws: string, code = 'good-code') => {
    const start = await inject(
      cookie,
      'GET',
      `/v1/workspaces/${ws}/social-accounts/linkedin/connect`,
    );
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await inject(cookie, 'GET', `/oauth/linkedin/callback?code=${code}&state=${state}`);
    return locationOf(cb);
  };

  const notionFlow = async (cookie: string, ws: string, code = 'notion-good') => {
    const start = await inject(
      cookie,
      'GET',
      `/v1/workspaces/${ws}/content-sources/notion/connect`,
    );
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.origin + authUrl.pathname).toBe('https://api.notion.com/v1/oauth/authorize');
    expect(authUrl.searchParams.get('owner')).toBe('user');
    expect(authUrl.searchParams.get('client_id')).toBe('notion-client');
    const state = authUrl.searchParams.get('state')!;
    const cb = await inject(cookie, 'GET', `/oauth/notion/callback?code=${code}&state=${state}`);
    return locationOf(cb);
  };

  const maintenance = () =>
    runMaintenance(
      {
        reconciliation: stack.services.reconciliation,
        alerts: stack.services.alerts,
        tokenExpiry: stack.services.tokenExpiry,
        digest: stack.services.digest,
        heartbeat: stack.services.heartbeat,
        notionWebhooks: stack.services.notionWebhooks,
        media: stack.services.media,
        billing: stack.services.billing,
      },
      `maint-${++eventSeq}`,
      pino({ level: 'silent' }),
    );

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        NOTION_CLIENT_ID: 'notion-client',
        NOTION_CLIENT_SECRET: 'notion-secret',
        STRIPE_SECRET_KEY: 'sk_test_unused',
        STRIPE_WEBHOOK_SECRET,
        STRIPE_PRICE_SOLO: PRICES.solo,
        STRIPE_PRICE_TEAM: PRICES.team,
        STRIPE_PRICE_AGENCY: PRICES.agency,
      },
      billingGateway: gateway,
    });
    ownerEmail = uniqueEmail('p3-owner');
    ({ cookie: ownerCookie, workspaceId } = await stack.signInWithWorkspace(ownerEmail));
  });
  afterAll(async () => {
    await stack.close();
  });

  // ---------------------------------------------------------------------------
  // Notion OAuth onboarding
  // ---------------------------------------------------------------------------

  describe('Notion OAuth onboarding', () => {
    it('advertises OAuth availability and connects a pending source that needs setup', async () => {
      const list = await inject(
        ownerCookie,
        'GET',
        `/v1/workspaces/${workspaceId}/social-accounts`,
      );
      expect(list.json<{ notionOAuthConfigured: boolean }>().notionOAuthConfigured).toBe(true);

      const location = await notionFlow(ownerCookie, workspaceId);
      expect(location).toMatch(new RegExp(`^/w/${workspaceId}/setup\\?source=`));
      expect(location).toContain('connected=notion');
      const sourceId = new URL(location, 'http://localhost').searchParams.get('source')!;

      const sources = await inject(
        ownerCookie,
        'GET',
        `/v1/workspaces/${workspaceId}/content-sources`,
      );
      const src = sources
        .json<{
          sources: {
            id: string;
            status: string;
            setupPending: boolean;
            authKind: string;
            notionWorkspaceName: string | null;
            databaseId: string | null;
          }[];
        }>()
        .sources.find((s) => s.id === sourceId)!;
      expect(src).toMatchObject({
        status: 'disabled',
        setupPending: true,
        authKind: 'oauth',
        notionWorkspaceName: 'Acme Notion',
        databaseId: null,
      });

      // The token is sealed in the database, never stored in Notion or returned.
      const [row] = await stack.db.db
        .select()
        .from(contentSource)
        .where(eq(contentSource.id, sourceId));
      expect(JSON.stringify(row)).not.toContain(NOTION_VALID_TOKEN);
      expect(sources.body).not.toContain(NOTION_VALID_TOKEN);

      // Setup options come from Notion search restricted to what the user shared.
      const options = await inject(
        ownerCookie,
        'GET',
        `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
      );
      expect(options.statusCode).toBe(200);
      const opts = options.json<{
        pages: { id: string; title: string }[];
        databases: { id: string; title: string }[];
      }>();
      expect(opts.pages.map((p) => p.title)).toContain('Marketing');
      expect(opts.databases.map((d) => d.title)).toContain('Content Calendar');

      // Create the template database in the chosen page and activate the source.
      const before = fake.notion.createdDatabases.size;
      const done = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
        { mode: 'create', parentPageId: opts.pages[0]!.id, title: 'Team Content' },
      );
      expect(done.statusCode).toBe(200);
      expect(
        done.json<{ status: string; setupPending: boolean; databaseTitle: string }>(),
      ).toMatchObject({ status: 'active', setupPending: false, databaseTitle: 'Team Content' });
      // The template suite creates content, campaigns, ideas and analytics databases together.
      expect(fake.notion.createdDatabases.size).toBe(before + 4);
      const audit = await stack.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'content_source.setup_completed'));
      expect(audit.some((a) => a.entityId === sourceId)).toBe(true);

      // Setup is one-shot: a second attempt on an active source is rejected.
      const again = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
        { mode: 'existing', databaseId: NOTION_GOOD_DB },
      );
      expect(again.statusCode).toBe(409);
    });

    it('adopts an existing database when it matches the template, and rejects a broken one', async () => {
      const { cookie, workspaceId: ws } = await stack.signInWithWorkspace(uniqueEmail('p3-adopt'));
      const location = await notionFlow(cookie, ws);
      const sourceId = new URL(location, 'http://localhost').searchParams.get('source')!;
      const bad = await inject(
        cookie,
        'POST',
        `/v1/workspaces/${ws}/content-sources/${sourceId}/setup`,
        { mode: 'existing', databaseId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee' },
      );
      expect(bad.statusCode).toBe(422);
      const good = await inject(
        cookie,
        'POST',
        `/v1/workspaces/${ws}/content-sources/${sourceId}/setup`,
        { mode: 'existing', databaseId: NOTION_GOOD_DB },
      );
      expect(good.statusCode).toBe(200);
      expect(good.json<{ status: string }>().status).toBe('active');
    });

    it('reports a failed code exchange back to the connections page without creating a source', async () => {
      const { cookie, workspaceId: ws } = await stack.signInWithWorkspace(
        uniqueEmail('p3-badcode'),
      );
      const location = await notionFlow(cookie, ws, 'notion-bad');
      expect(location).toContain('error=');
      const sources = await inject(cookie, 'GET', `/v1/workspaces/${ws}/content-sources`);
      expect(sources.json<{ sources: unknown[] }>().sources).toHaveLength(0);
    });

    it('still accepts a pasted internal token', async () => {
      const { cookie, workspaceId: ws } = await stack.signInWithWorkspace(uniqueEmail('p3-token'));
      const res = await inject(cookie, 'POST', `/v1/workspaces/${ws}/content-sources/notion`, {
        token: NOTION_VALID_TOKEN,
        database: NOTION_GOOD_DB,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ authKind: string; setupPending: boolean }>()).toMatchObject({
        authKind: 'token',
        setupPending: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  describe('teams', () => {
    let inviteeEmail: string;
    let inviteeCookie: string;
    let inviteeId: string;
    let token: string;
    const tokenIn = (text: string) => text.match(/\/invitations\/([A-Za-z0-9_-]+)/)![1]!;

    it('invites by email with a hashed 7-day token and lists open invitations', async () => {
      // Free plan allows one member: the invite is refused until the plan grows.
      inviteeEmail = uniqueEmail('p3-invitee');
      const refused = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/invitations`,
        { email: inviteeEmail, role: 'editor' },
      );
      expect(refused.statusCode).toBe(402);
      expect(refused.json<{ code: string }>().code).toBe('plan_limit');

      // Simulate a Team subscription arriving from Stripe, then invite again.
      const created = await postStripe(
        stripeEventBody(
          'customer.subscription.created',
          subscriptionObject('sub_team_1', 'cus_team_1', PRICES.team, 'active'),
        ),
      );
      expect(created.statusCode).toBe(200);
      expect((await usage()).plan).toBe('team');

      stack.mailer.sent.length = 0;
      const res = await inject(ownerCookie, 'POST', `/v1/workspaces/${workspaceId}/invitations`, {
        email: inviteeEmail,
        role: 'editor',
      });
      expect(res.statusCode).toBe(201);
      const dto = res.json<{ id: string; email: string; role: string; expiresAt: string }>();
      expect(dto.role).toBe('editor');
      const ttl = Date.parse(dto.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(6.9 * 86400_000);
      expect(ttl).toBeLessThanOrEqual(7 * 86400_000 + 5000);

      const mail = stack.mailer.lastTo(inviteeEmail);
      expect(mail).toBeDefined();
      token = tokenIn(mail!.text);
      // Only the hash is stored.
      const [row] = await stack.db.db.select().from(invitation).where(eq(invitation.id, dto.id));
      expect(row!.tokenHash).not.toBe(token);
      expect(row!.tokenHash).toHaveLength(64);

      const list = await inject(ownerCookie, 'GET', `/v1/workspaces/${workspaceId}/invitations`);
      expect(list.json<{ invitations: { id: string }[] }>().invitations.map((i) => i.id)).toContain(
        dto.id,
      );
    });

    it('lets any signed-in user peek and accept; the membership gets the invited role', async () => {
      const anon = await stack.app.inject({ method: 'GET', url: `/v1/invitations/${token}` });
      expect(anon.statusCode).toBe(401);

      inviteeCookie = await stack.signIn(inviteeEmail);
      const peek = await inject(inviteeCookie, 'GET', `/v1/invitations/${token}`);
      expect(peek.statusCode).toBe(200);
      expect(peek.json<{ role: string; email: string }>()).toMatchObject({
        role: 'editor',
        email: inviteeEmail,
      });

      const accept = await inject(inviteeCookie, 'POST', `/v1/invitations/${token}/accept`, {});
      expect(accept.statusCode).toBe(200);
      expect(accept.json<{ workspaceId: string; role: string }>()).toEqual({
        workspaceId,
        role: 'editor',
      });
      const m = await me(inviteeCookie);
      inviteeId = m.user.id;
      expect(m.workspaces.find((w) => w.id === workspaceId)?.role).toBe('editor');

      // Used tokens are gone.
      const again = await inject(inviteeCookie, 'GET', `/v1/invitations/${token}`);
      expect(again.statusCode).toBe(410);
      const reaccept = await inject(inviteeCookie, 'POST', `/v1/invitations/${token}/accept`, {});
      expect([404, 409, 410]).toContain(reaccept.statusCode);
    });

    it('lists members and lets admins change roles; editors cannot manage the team', async () => {
      const list = await inject(inviteeCookie, 'GET', `/v1/workspaces/${workspaceId}/members`);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ members: unknown[] }>().members).toHaveLength(2);

      const forbidden = await inject(
        inviteeCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/invitations`,
        { email: uniqueEmail('x'), role: 'viewer' },
      );
      expect(forbidden.statusCode).toBe(403);

      const promote = await inject(
        ownerCookie,
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${inviteeId}`,
        { role: 'admin' },
      );
      expect(promote.statusCode).toBe(200);
      expect(promote.json<{ role: string }>().role).toBe('admin');

      // An admin may not grant owner.
      const inv = await inject(inviteeCookie, 'POST', `/v1/workspaces/${workspaceId}/invitations`, {
        email: uniqueEmail('p3-third'),
        role: 'owner',
      });
      expect(inv.statusCode).toBe(403);
    });

    it('never removes or demotes the last owner', async () => {
      const ownerId = (await me(ownerCookie)).user.id;
      const demote = await inject(
        ownerCookie,
        'PATCH',
        `/v1/workspaces/${workspaceId}/members/${ownerId}`,
        { role: 'admin' },
      );
      expect(demote.statusCode).toBe(409);
      expect(demote.json<{ code: string }>().code).toBe('last_owner');
      const leave = await inject(
        ownerCookie,
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${ownerId}`,
      );
      expect(leave.statusCode).toBe(409);
    });

    it('revokes open invitations and removes members with an audit trail', async () => {
      const email = uniqueEmail('p3-revoke');
      const inv = await inject(ownerCookie, 'POST', `/v1/workspaces/${workspaceId}/invitations`, {
        email,
        role: 'viewer',
      });
      const id = inv.json<{ id: string }>().id;
      const revoke = await inject(
        ownerCookie,
        'DELETE',
        `/v1/workspaces/${workspaceId}/invitations/${id}`,
      );
      expect(revoke.statusCode).toBe(204);
      const revokedToken = tokenIn(stack.mailer.lastTo(email)!.text);
      const peek = await inject(ownerCookie, 'GET', `/v1/invitations/${revokedToken}`);
      expect(peek.statusCode).toBe(410);

      const remove = await inject(
        ownerCookie,
        'DELETE',
        `/v1/workspaces/${workspaceId}/members/${inviteeId}`,
      );
      expect(remove.statusCode).toBe(204);
      const rows = await stack.db.db
        .select()
        .from(membership)
        .where(eq(membership.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
      const events = (
        await stack.db.db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId))
      ).map((a) => a.event);
      for (const e of [
        'invitation.created',
        'invitation.accepted',
        'invitation.revoked',
        'membership.role_changed',
        'membership.removed',
      ]) {
        expect(events).toContain(e);
      }
      // The removed user no longer sees the workspace.
      expect((await me(inviteeCookie)).workspaces.map((w) => w.id)).not.toContain(workspaceId);
    });

    it('creates additional workspaces and lists them for switching', async () => {
      const res = await inject(ownerCookie, 'POST', '/v1/workspaces', {
        name: 'Second Brand',
        defaultTimezone: 'Europe/Berlin',
      });
      expect(res.statusCode).toBe(201);
      const ws = res.json<{ id: string; name: string; defaultTimezone: string; plan: string }>();
      expect(ws).toMatchObject({
        name: 'Second Brand',
        defaultTimezone: 'Europe/Berlin',
        plan: 'free',
      });
      const list = (await me(ownerCookie)).workspaces;
      expect(list.find((w) => w.id === ws.id)?.role).toBe('owner');
      expect(list.length).toBeGreaterThanOrEqual(2);
      const badTz = await inject(ownerCookie, 'POST', '/v1/workspaces', {
        name: 'x',
        defaultTimezone: 'Mars/Olympus',
      });
      expect(badTz.statusCode).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------------------

  describe('billing', () => {
    it('reports usage against the effective plan', async () => {
      const u = await usage();
      expect(u.plan).toBe('team');
      expect(u.limits).toEqual({ ...PLANS.team.limits });
      expect(u.used.members).toBe(1);
      expect(u.billingConfigured).toBe(true);
      expect(u.availablePlans.map((p) => p.id)).toEqual(['solo', 'team', 'agency']);
    });

    it('starts Checkout through the gateway with the workspace bound in metadata, owners only', async () => {
      const res = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/billing/checkout`,
        { plan: 'solo' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json<{ url: string }>().url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      const last = gateway.checkouts.at(-1)!;
      expect(last.workspaceId).toBe(workspaceId);
      expect(last.priceId).toBe(PRICES.solo);
      expect(last.successUrl).toContain(`/w/${workspaceId}/billing`);
      expect(last.customerEmail).toBe(ownerEmail);

      const unknown = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/billing/checkout`,
        { plan: 'gold' },
      );
      expect(unknown.statusCode).toBe(400);

      const { cookie: other } = await stack.signInWithWorkspace(uniqueEmail('p3-stranger'));
      const denied = await inject(other, 'POST', `/v1/workspaces/${workspaceId}/billing/checkout`, {
        plan: 'solo',
      });
      expect([403, 404]).toContain(denied.statusCode);
    });

    it('rejects unsigned or badly signed webhooks and deduplicates events', async () => {
      const payload = stripeEventBody('invoice.paid', { id: 'in_x', object: 'invoice' });
      const unsigned = await stack.app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(unsigned.statusCode).toBe(400);
      const wrong = await postStripe(payload, 'whsec_wrong');
      expect(wrong.statusCode).toBe(400);
      const ok = await postStripe(payload);
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ outcome: string }>().outcome).toBe('ignored:no_subscription');
      const dup = await postStripe(payload);
      expect(dup.json<{ outcome: string }>().outcome).toBe('duplicate');
      const stored = await stack.db.db
        .select()
        .from(stripeEvent)
        .where(eq(stripeEvent.type, 'invoice.paid'));
      expect(stored.length).toBeGreaterThanOrEqual(1);
    });

    it('links the customer on checkout completion and opens the portal for it', async () => {
      const res = await postStripe(
        stripeEventBody('checkout.session.completed', {
          id: 'cs_test_1',
          object: 'checkout.session',
          customer: 'cus_team_1',
          customer_details: { email: ownerEmail },
          metadata: { workspaceId },
        }),
      );
      expect(res.json<{ outcome: string }>().outcome).toBe('customer_linked');
      const portal = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/billing/portal`,
        {},
      );
      expect(portal.statusCode).toBe(200);
      expect(gateway.portals.at(-1)?.customerId).toBe('cus_team_1');
    });

    it('enforces the account limit with 402 and the monthly post limit with PLAN_LIMIT', async () => {
      // Downgrade to Solo (3 accounts) via a subscription update, then connect past the cap.
      await postStripe(
        stripeEventBody(
          'customer.subscription.updated',
          subscriptionObject('sub_team_1', 'cus_team_1', PRICES.solo, 'active'),
        ),
      );
      expect((await usage()).plan).toBe('solo');
      const [ws] = await stack.db.db.select().from(workspace).where(eq(workspace.id, workspaceId));
      expect(ws!.plan).toBe('solo');

      // Every fake LinkedIn login yields the same member; fill the seats directly.
      const ownerId = (await me(ownerCookie)).user.id;
      for (let i = 0; i < PLANS.solo.limits.accounts; i++) {
        await stack.db.db.insert(socialAccount).values({
          id: `0199a000-0000-7000-8000-0000000003${String(i).padStart(2, '0')}`,
          workspaceId,
          provider: 'linkedin',
          accountType: 'member',
          providerAccountId: `p3-acc-${i}-${workspaceId.slice(0, 8)}`,
          displayName: `Seat ${i}`,
          status: 'active',
          connectedByUserId: ownerId,
        });
      }
      expect((await usage()).used.accounts).toBe(PLANS.solo.limits.accounts);
      const location = await linkedInFlow(ownerCookie, workspaceId);
      expect(location).toContain('error=');
      expect(decodeURIComponent(location)).toMatch(/plan/i);
      expect((await usage()).used.accounts).toBe(PLANS.solo.limits.accounts);

      // Meter published posts from the audit stream; the next scheduled page is refused.
      for (let i = 0; i < PLANS.solo.limits.postsPerMonth; i++) {
        await recordAudit(stack.db.db, {
          workspaceId,
          actor: { type: 'system', id: 'test' },
          entityType: 'publication',
          entityId: `meter-${i}`,
          event: 'publication.state_changed',
          fromState: 'publishing',
          toState: 'published',
        });
      }
      expect((await usage()).used.postsThisMonth).toBe(PLANS.solo.limits.postsPerMonth);

      const sources = (
        await inject(ownerCookie, 'GET', `/v1/workspaces/${workspaceId}/content-sources`)
      ).json<{ sources: { id: string; status: string }[] }>().sources;
      const sourceId = sources.find((s) => s.status === 'active')!.id;
      const pageId = `p3-limit-${Date.now().toString(36)}`;
      fake.notion.upsert(pageId, {
        status: 'Scheduled',
        title: 'Over the limit',
        platforms: ['LinkedIn'],
        publishDate: { start: new Date(stack.clock.now().getTime() + 3600_000).toISOString() },
        body: ['hello'],
      });
      const sync = await inject(
        ownerCookie,
        'POST',
        `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
        {},
      );
      expect([200, 207]).toContain(sync.statusCode);
      const posts = (await inject(ownerCookie, 'GET', `/v1/workspaces/${workspaceId}/posts`)).json<{
        posts: {
          title: string;
          state: string;
          validationErrors: { code: string }[] | null;
          publications: unknown[];
        }[];
      }>().posts;
      const p = posts.find((x) => x.title === 'Over the limit')!;
      // Validation failures keep the editorial state; the errors and the Notion status tell the story.
      expect(p.state).toBe('scheduled');
      expect(p.validationErrors?.some((e) => e.code === 'PLAN_LIMIT')).toBe(true);
      expect(p.publications).toHaveLength(0);
      expect(fake.notion.pages.get(pageId)!.system.postelyoStatus).toBe('Validation error');
    });

    it('keeps paid limits during the grace period after a failed payment, then drops to Free', async () => {
      const failed = await postStripe(
        stripeEventBody('invoice.payment_failed', {
          id: 'in_fail_1',
          object: 'invoice',
          parent: { subscription_details: { subscription: 'sub_team_1' } },
        }),
      );
      expect(failed.json<{ outcome: string }>().outcome).toBe('grace_started');
      let u = await usage();
      expect(u.plan).toBe('solo');
      expect(u.subscription?.status).toBe('past_due');
      expect(u.subscription?.graceUntil).not.toBeNull();

      await maintenance();
      expect((await usage()).plan).toBe('solo');

      stack.clock.advance(GRACE_PERIOD_MS + 60_000);
      await maintenance();
      u = await usage();
      expect(u.plan).toBe('free');
      const [ws] = await stack.db.db.select().from(workspace).where(eq(workspace.id, workspaceId));
      expect(ws!.plan).toBe('free');
      const changes = await stack.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'billing.plan_changed'));
      expect(changes.some((c) => c.workspaceId === workspaceId && c.toState === 'free')).toBe(true);

      // Payment recovered: back to the paid plan.
      const paid = await postStripe(
        stripeEventBody('invoice.paid', {
          id: 'in_ok_1',
          object: 'invoice',
          parent: { subscription_details: { subscription: 'sub_team_1' } },
        }),
      );
      expect(paid.json<{ outcome: string }>().outcome).toBe('payment_recorded');
      expect((await usage()).plan).toBe('solo');

      // Cancellation drops to Free immediately.
      await postStripe(
        stripeEventBody(
          'customer.subscription.deleted',
          subscriptionObject('sub_team_1', 'cus_team_1', PRICES.solo, 'canceled'),
        ),
      );
      expect((await usage()).plan).toBe('free');
      const [sub] = await stack.db.db
        .select()
        .from(subscription)
        .where(eq(subscription.stripeSubscriptionId, 'sub_team_1'));
      expect(sub!.status).toBe('canceled');
    });
  });

  // ---------------------------------------------------------------------------
  // Notification settings, deletion, legal pages
  // ---------------------------------------------------------------------------

  describe('notifications and compliance', () => {
    it('stores notification overrides and validates them', async () => {
      const bad = await inject(ownerCookie, 'PATCH', `/v1/workspaces/${workspaceId}`, {
        notificationEmail: 'nope',
      });
      expect(bad.statusCode).toBe(422);
      const ok = await inject(ownerCookie, 'PATCH', `/v1/workspaces/${workspaceId}`, {
        notificationEmail: 'social@example.com',
        alertCopyEmail: 'ops-copy@example.com',
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<{ notificationEmail: string; alertCopyEmail: string }>()).toMatchObject({
        notificationEmail: 'social@example.com',
        alertCopyEmail: 'ops-copy@example.com',
      });

      // Alerts for this workspace are copied to the override address.
      stack.mailer.sent.length = 0;
      await stack.services.alerts.raise(
        'publication.overdue',
        `p3-alert-${Date.now()}`,
        'Test alert body',
        workspaceId,
        'corr-p3',
      );
      expect(stack.mailer.sent.some((m) => m.to === 'ops-copy@example.com')).toBe(true);
      expect(stack.mailer.sent.some((m) => m.to === 'ops@example.com')).toBe(true);

      const cleared = await inject(ownerCookie, 'PATCH', `/v1/workspaces/${workspaceId}`, {
        alertCopyEmail: null,
      });
      expect(cleared.json<{ alertCopyEmail: string | null }>().alertCopyEmail).toBeNull();
    });

    it('serves privacy and terms pages without a session', async () => {
      for (const path of ['/privacy', '/terms']) {
        const res = await stack.app.inject({ method: 'GET', url: path });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
      }
    });

    it('soft-deletes a workspace on request, then purges it and anonymises the audit trail', async () => {
      const { cookie, workspaceId: ws } = await stack.signInWithWorkspace(uniqueEmail('p3-delete'));
      await inject(cookie, 'POST', `/v1/workspaces/${ws}/content-sources/notion`, {
        token: NOTION_VALID_TOKEN,
        database: NOTION_GOOD_DB,
      });
      await linkedInFlow(cookie, ws);
      const pageId = `p3-del-${Date.now().toString(36)}`;
      fake.notion.upsert(pageId, {
        status: 'Scheduled',
        title: 'Will be cancelled',
        platforms: ['LinkedIn'],
        publishDate: { start: new Date(stack.clock.now().getTime() + 3600_000).toISOString() },
        body: ['bye'],
      });
      const sources = (await inject(cookie, 'GET', `/v1/workspaces/${ws}/content-sources`)).json<{
        sources: { id: string }[];
      }>().sources;
      await inject(
        cookie,
        'POST',
        `/v1/workspaces/${ws}/content-sources/${sources[0]!.id}/sync`,
        {},
      );

      // Members other than the owner cannot delete.
      const { cookie: other } = await stack.signInWithWorkspace(uniqueEmail('p3-notowner'));
      const denied = await inject(other, 'DELETE', `/v1/workspaces/${ws}`);
      expect([403, 404]).toContain(denied.statusCode);

      stack.enqueue.deletions.length = 0;
      const res = await inject(cookie, 'DELETE', `/v1/workspaces/${ws}`);
      expect(res.statusCode).toBe(202);
      expect(res.json<{ status: string }>().status).toBe('deleting');
      expect(stack.enqueue.deletions).toEqual([{ workspaceId: ws }]);

      // Hidden immediately; scheduled work cancelled; API access gone.
      expect((await me(cookie)).workspaces.map((w) => w.id)).not.toContain(ws);
      const gone = await inject(cookie, 'GET', `/v1/workspaces/${ws}/posts`);
      expect([403, 404]).toContain(gone.statusCode);
      const [row] = await stack.db.db.select().from(workspace).where(eq(workspace.id, ws));
      expect(row!.deletedAt).not.toBeNull();
      const pubs = await stack.db.db
        .select()
        .from(publication)
        .where(eq(publication.workspaceId, ws));
      expect(pubs.length).toBeGreaterThan(0);
      expect(pubs.every((p) => p.state === 'cancelled')).toBe(true);

      // Purge (normally the queued job): tokens revoked best-effort, rows gone, audit anonymised.
      const outcome = await stack.services.deletion.purge(ws, 'purge-test');
      expect(outcome).toBe('purged');
      expect(await stack.db.db.select().from(workspace).where(eq(workspace.id, ws))).toHaveLength(
        0,
      );
      expect(
        await stack.db.db.select().from(socialAccount).where(eq(socialAccount.workspaceId, ws)),
      ).toHaveLength(0);
      const audit = await stack.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'workspace.deleted'));
      const mine = audit.filter((a) => a.entityId === ws);
      expect(mine.map((a) => (a.data as { stage: string }).stage).sort()).toEqual([
        'purged',
        'requested',
      ]);
      expect(await stack.services.deletion.purge(ws, 'purge-again')).toBe('skipped');
    });
  });
});
