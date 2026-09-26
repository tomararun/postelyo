import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  post,
  publication,
  socialAccount,
  webhookEvent,
} from '../../src/infra/db/schema.js';
import { runMaintenance } from '../../src/jobs/maintenance.job.js';
import type { FakeProvider } from '@postelyo/publishing-core';
import { MAX_RECONCILE_ATTEMPTS } from '../../src/modules/publishing/reconciliation.service.js';
import { NOTION_GOOD_DB, NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';
import { pino } from 'pino';

const WEBHOOK_SECRET = 'secret_notion_webhook_verification_token_1234';

/**
 * Phase 1 hardening: LinkedIn Pages, ambiguous reconciliation, daily caps and
 * rate limits, Notion webhooks. Everything runs through the FakeProvider and
 * the fake LinkedIn/Notion HTTP endpoints.
 */
describe('phase 1 hardening', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let memberAccountId: string;
  let provider: FakeProvider;
  let seq = 0;

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
    return res.json<{ actions: Record<string, number>; errors: string[] }>();
  };

  const linkedInFlow = async (
    type: 'member' | 'organization',
    code = type === 'organization' ? 'good-code-org' : 'good-code',
  ) => {
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect?type=${type}`,
      headers: { cookie },
    });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    const state = authUrl.searchParams.get('state')!;
    const cb = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=${code}&state=${state}`,
      headers: { cookie },
    });
    return { scope: authUrl.searchParams.get('scope') ?? '', location: locationOf(cb) };
  };

  const accounts = async () => {
    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    return list.json<{
      accounts: {
        id: string;
        accountType: string;
        displayName: string;
        status: string;
        disconnectedAt: string | null;
      }[];
    }>().accounts;
  };

  /** Scheduled Notion page whose date is already due; returns post and publications. */
  const duePage = async (
    opts: { platforms?: string[]; body?: string; minutesAgo?: number } = {},
  ) => {
    const id = `p1-page-${++seq}`;
    fake.notion.upsert(id, {
      status: 'Scheduled',
      title: id,
      platforms: opts.platforms ?? ['LinkedIn'],
      publishDate: {
        start: new Date(
          stack.clock.now().getTime() - (opts.minutesAgo ?? 1) * 60_000,
        ).toISOString(),
      },
      body: [opts.body ?? `body of ${id}`],
    });
    await sync();
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, id));
    const pubs = p
      ? await stack.db.db.select().from(publication).where(eq(publication.postId, p.id))
      : [];
    return { pageId: id, post: p!, pubs };
  };

  const reload = async (id: string) =>
    (await stack.db.db.select().from(publication).where(eq(publication.id, id)))[0]!;

  const cancelPage = async (pageId: string) => {
    fake.notion.upsert(pageId, { status: 'Cancelled' });
    await sync();
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        NOTION_WEBHOOK_SECRET: WEBHOOK_SECRET,
      },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p1')));
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = connect.json<{ id: string }>().id;
    await linkedInFlow('member');
    memberAccountId = (await accounts())[0]!.id;
    provider = stack.services.providers.get('linkedin') as FakeProvider;
  });
  afterAll(async () => {
    await stack.close();
  });

  // ---------------------------------------------------------------------------
  // LinkedIn organization pages
  // ---------------------------------------------------------------------------

  it('connects the LinkedIn Pages the member administers, with organization scopes', async () => {
    const { scope, location } = await linkedInFlow('organization');
    expect(scope).toContain('w_organization_social');
    expect(scope).toContain('rw_organization_admin');
    expect(location).toBe(`/w/${workspaceId}/connections?connected=linkedin-pages`);

    const all = await accounts();
    const pages = all.filter((a) => a.accountType === 'organization');
    expect(pages.map((p) => p.displayName).sort()).toEqual(['Acme Corp', 'Acme Labs']);
    expect(all.filter((a) => a.accountType === 'member')).toHaveLength(1);

    const [row] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.workspaceId, workspaceId),
          eq(socialAccount.providerAccountId, '1001'),
        ),
      );
    expect(row?.accountType).toBe('organization');
    expect(row?.accessTokenEnc).not.toBeNull();
    expect(row?.scopes).toContain('w_organization_social');

    const page = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/connections`,
      headers: { cookie },
    });
    expect(page.body).toContain('LinkedIn Pages');
    expect(page.body).toContain('Acme Corp');
    expect(page.body).toContain('type=organization');

    // Reconnecting refreshes rather than duplicates.
    await linkedInFlow('organization');
    expect((await accounts()).filter((a) => a.accountType === 'organization')).toHaveLength(2);
  });

  it('explains when the member administers no page or the app lacks access', async () => {
    fake.setOrganizations([]);
    let r = await linkedInFlow('organization');
    expect(decodeURIComponent(r.location)).toContain('no Pages that you administer');
    fake.setOrganizations([{ id: '1001', name: 'Acme Corp', vanity: 'acme' }]);
    fake.setOrganizationsStatus(403);
    r = await linkedInFlow('organization');
    expect(decodeURIComponent(r.location)).toContain('Community Management API');
    fake.setOrganizationsStatus(200);
  });

  it('publishes a Notion page marked "LinkedIn Page" as the organization, picking one of several by name', async () => {
    // Two pages connected → ambiguous until qualified.
    const amb = await duePage({ platforms: ['LinkedIn Page'] });
    expect(amb.pubs).toHaveLength(0);
    expect((amb.post.validationErrors as { code: string }[]).map((e) => e.code)).toContain(
      'AMBIGUOUS_ACCOUNT',
    );
    fake.notion.upsert(amb.pageId, { platforms: ['LinkedIn Page: Acme Labs', 'LinkedIn'] });
    await sync();
    const pubs = await stack.db.db
      .select()
      .from(publication)
      .where(eq(publication.postId, amb.post.id));
    expect(pubs).toHaveLength(2);
    const orgPub = pubs.find((p) => p.socialAccountId !== memberAccountId)!;
    const [orgAcc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, orgPub.socialAccountId));
    expect(orgAcc?.displayName).toBe('Acme Labs');

    await stack.services.scheduler.tick('p1-org');
    expect(
      await stack.services.engine.handle(
        { publicationId: orgPub.id, cycleNo: orgPub.cycleNo },
        'o',
      ),
    ).toBe('published');
    const call = provider.calls.at(-1)!;
    expect(call.input.account.accountType).toBe('organization');
    expect(call.input.account.providerAccountId).toBe('1002');
    const memberPub = pubs.find((p) => p.socialAccountId === memberAccountId)!;
    expect(
      await stack.services.engine.handle(
        { publicationId: memberPub.id, cycleNo: memberPub.cycleNo },
        'm',
      ),
    ).toBe('published');

    // With only one page left, the bare option resolves on its own.
    const [labs] = await stack.db.db
      .select({ id: socialAccount.id })
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.workspaceId, workspaceId),
          eq(socialAccount.providerAccountId, '1001'),
        ),
      );
    await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${labs!.id}`,
      headers: { cookie },
    });
    const single = await duePage({ platforms: ['LinkedIn Page'] });
    expect(single.pubs).toHaveLength(1);
    await cancelPage(single.pageId);
  });

  // ---------------------------------------------------------------------------
  // Reconciliation of ambiguous outcomes
  // ---------------------------------------------------------------------------

  it('reconciles an ambiguous publication when the provider shows exactly one matching post', async () => {
    const { pageId, pubs } = await duePage({ body: 'Reconcile me #please' });
    const pub = pubs[0]!;
    await stack.services.scheduler.tick('p1-rec');
    provider.scriptOutcomes({ kind: 'ambiguous', reason: 'timeout after send' });
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'r'),
    ).toBe('ambiguous');
    const renderedText = provider.calls.at(-1)!.input.content.text;

    // Nothing at the provider yet: unresolved, counted. (Other suites leave ambiguous rows
    // behind, so the assertions are on this publication rather than on global totals.)
    let summary = await stack.services.reconciliation.run('rec-0');
    expect(summary.checked).toBeGreaterThanOrEqual(1);
    expect(summary.resolvedPublished).toBe(0);
    expect(await reload(pub.id)).toMatchObject({ state: 'ambiguous', reconcileAttempts: 1 });

    // A different post in the window is not a match; the real one is.
    provider.seedRecentPost(memberAccountId, {
      providerPostId: 'urn:li:share:other',
      text: 'Something else entirely',
      publishedAt: stack.clock.now(),
    });
    const seenAt = new Date(stack.clock.now().getTime() - 30_000);
    provider.seedRecentPost(memberAccountId, {
      providerPostId: 'urn:li:share:found',
      text: renderedText,
      publishedAt: seenAt,
    });
    stack.enqueue.reset();
    summary = await stack.services.reconciliation.run('rec-1');
    expect(summary.resolvedPublished).toBe(1);
    const row = await reload(pub.id);
    expect(row).toMatchObject({
      state: 'published',
      providerPostId: 'urn:li:share:found',
      providerPostUrl: 'https://fake.postelyo.local/recent/urn:li:share:found',
    });
    expect(row.publishedAt!.getTime()).toBe(seenAt.getTime());
    expect(stack.enqueue.writebacks.map((w) => w.publicationId)).toContain(pub.id);
    await stack.services.resultWriteback.writeback(pub.id, 'wb');
    expect(fake.notion.pages.get(pageId)?.system.postelyoStatus).toBe('Published');
    expect(fake.notion.pages.get(pageId)?.system.publishedUrl).toBe(row.providerPostUrl);

    const events = await stack.db.db
      .select({ event: auditLog.event, data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, pub.id), eq(auditLog.entityType, 'publication')));
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['publication.reconciliation_unresolved', 'publication.reconciled']),
    );
    const resolved = events.find(
      (e) =>
        e.event === 'publication.state_changed' &&
        JSON.stringify(e.data).includes('reconciliation'),
    );
    expect(resolved).toBeDefined();
    provider.recentPosts.clear();
  });

  it('never resolves on several matches, stops checking after the cap, and still alerts', async () => {
    const { pageId, pubs } = await duePage({ body: 'Twins post' });
    const pub = pubs[0]!;
    await stack.services.scheduler.tick('p1-rec2');
    provider.scriptOutcomes({ kind: 'ambiguous', reason: 'lease expired' });
    await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'r2');
    const text = provider.calls.at(-1)!.input.content.text;
    for (const id of ['urn:li:share:t1', 'urn:li:share:t2']) {
      provider.seedRecentPost(memberAccountId, {
        providerPostId: id,
        text,
        publishedAt: stack.clock.now(),
      });
    }
    for (let i = 0; i < MAX_RECONCILE_ATTEMPTS; i++) {
      const s = await stack.services.reconciliation.run(`rec-twins-${i}`);
      expect(s.resolvedPublished).toBe(0);
      expect((await reload(pub.id)).reconcileAttempts).toBe(i + 1);
    }
    const s = await stack.services.reconciliation.run('rec-twins-x');
    expect(s.exhausted).toBeGreaterThanOrEqual(1);
    expect(await reload(pub.id)).toMatchObject({
      state: 'ambiguous',
      reconcileAttempts: MAX_RECONCILE_ATTEMPTS,
    });
    const reasons = await stack.db.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, pub.id),
          eq(auditLog.event, 'publication.reconciliation_unresolved'),
        ),
      );
    expect(reasons.map((r) => (r.data as { reason: string }).reason)).toEqual([
      'multiple_matches',
      'multiple_matches',
      'multiple_matches',
    ]);

    // Lookup outages are counted too and never change state.
    provider.recentPosts.clear();
    const { pubs: pubs2 } = await duePage({ body: 'Outage post' });
    await stack.services.scheduler.tick('p1-rec3');
    provider.scriptOutcomes({ kind: 'ambiguous', reason: 'timeout' });
    await stack.services.engine.handle(
      { publicationId: pubs2[0]!.id, cycleNo: pubs2[0]!.cycleNo },
      'r3',
    );
    provider.lookupError = new Error('LinkedIn 503');
    expect(
      (await stack.services.reconciliation.run('rec-outage')).lookupFailed,
    ).toBeGreaterThanOrEqual(1);
    provider.lookupError = null;
    expect(await reload(pubs2[0]!.id)).toMatchObject({ state: 'ambiguous', reconcileAttempts: 1 });

    // Maintenance runs reconciliation before the alert, which now reports the attempts made.
    stack.mailer.sent.length = 0;
    await runMaintenance(
      {
        reconciliation: stack.services.reconciliation,
        alerts: stack.services.alerts,
        tokenExpiry: stack.services.tokenExpiry,
        digest: stack.services.digest,
        heartbeat: stack.services.heartbeat,
        notionWebhooks: stack.services.notionWebhooks,
        media: stack.services.media,
      },
      'maint-1',
      pino({ level: 'silent' }),
    );
    const mail = stack.mailer.sent.find(
      (m) => m.subject.includes('publication.ambiguous') && m.text.includes(pub.id),
    );
    expect(mail?.text).toContain(`checked the provider ${MAX_RECONCILE_ATTEMPTS} time(s)`);

    // Operator resolution still works and clears the way.
    for (const p of [pub, pubs2[0]!]) {
      await stack.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/publications/${p.id}/resolve`,
        headers: { cookie },
        payload: { outcome: 'failed' },
      });
    }
    await cancelPage(pageId);
  });

  // ---------------------------------------------------------------------------
  // Daily caps and provider rate limits
  // ---------------------------------------------------------------------------

  it('defers publications beyond the per-account daily cap and explains it in Notion', async () => {
    const patch = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { dailyCapPerAccount: 1 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ dailyCapPerAccount: 1, dailyCapIsDefault: false });
    const bad = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { dailyCapPerAccount: 0 },
    });
    expect(bad.statusCode).toBe(422);

    // The member account already published in this window (earlier tests), so the very next due
    // publication is over the cap.
    const first = await duePage({ body: 'Capped one' });
    stack.enqueue.reset();
    const tick = await stack.services.scheduler.tick('p1-cap');
    expect(tick.deferred).toBeGreaterThanOrEqual(1);
    expect(tick.dispatched).toBe(0);
    let row = await reload(first.pubs[0]!.id);
    expect(row.state).toBe('scheduled');
    expect(row.deferredUntil).toBeInstanceOf(Date);
    expect(row.lastErrorCode).toBe('daily_cap');
    expect(row.lastErrorMessage).toContain('daily limit of 1 posts');
    expect(stack.enqueue.writebacks.map((w) => w.publicationId)).toContain(row.id);
    expect(await stack.services.resultWriteback.writeback(row.id, 'wb-cap')).toBe('done');
    expect(fake.notion.pages.get(first.pageId)?.system.postelyoNote).toContain('daily limit');

    // A re-sync keeps the deferral note instead of flipping back to "Scheduled for …".
    fake.notion.patches.length = 0;
    await sync();
    expect(fake.notion.pages.get(first.pageId)?.system.postelyoNote).toContain('daily limit');

    // Not an "overdue" alert, and visible as a deferred gauge.
    stack.mailer.sent.length = 0;
    await stack.services.alerts.evaluateWorker('cap-alert');
    expect(
      stack.mailer.sent.some(
        (m) => m.subject.includes('publication.overdue') && m.text.includes(row.id),
      ),
    ).toBe(false);
    const metrics = await stack.services.metrics.render();
    expect(metrics).toMatch(/postelyo_publications_deferred [1-9]/);

    // Once the window has passed, the deferred publication is dispatched and its note cleared.
    stack.clock.advance(24 * 60 * 60_000 + 60_000);
    const later = await stack.services.scheduler.tick('p1-cap-2');
    expect(later.dispatched).toBeGreaterThanOrEqual(1);
    row = await reload(row.id);
    expect(row.state).toBe('queued');
    expect(row.deferredUntil).toBeNull();
    expect(row.lastErrorCode).toBeNull();
    expect(
      await stack.services.engine.handle(
        { publicationId: row.id, cycleNo: row.cycleNo },
        'cap-pub',
      ),
    ).toBe('published');
    stack.clock.advance(-(24 * 60 * 60_000 + 60_000));

    // Restore the default cap.
    const reset = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { dailyCapPerAccount: null },
    });
    expect(reset.json()).toMatchObject({ dailyCapIsDefault: true });
  });

  it('treats a provider rate limit as a wait that keeps the attempt budget', async () => {
    const { pageId, pubs } = await duePage({ body: 'Throttled' });
    const pub = pubs[0]!;
    expect((await stack.services.scheduler.tick('p1-rl')).dispatched).toBeGreaterThanOrEqual(1);
    stack.enqueue.reset();
    provider.scriptOutcomes({
      kind: 'retryable_error',
      code: 'rate_limit',
      reason: 'LinkedIn rate limit reached',
      retryAfterMs: 2 * 60 * 60_000,
    });
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'rl'),
    ).toBe('retry_scheduled');
    const row = await reload(pub.id);
    expect(row.state).toBe('retry_wait');
    expect(row.attemptNo).toBe(0);
    expect(row.lastErrorCode).toBe('rate_limited');
    const wait = row.nextAttemptAt!.getTime() - stack.clock.now().getTime();
    expect(wait).toBeGreaterThan(2 * 60 * 60_000 - 10_000);
    expect(wait).toBeLessThanOrEqual(2 * 60 * 60_000);
    const job = stack.enqueue.published.find((p) => p.data.publicationId === pub.id);
    expect(job?.startAfter?.getTime()).toBe(row.nextAttemptAt!.getTime());
    await stack.services.resultWriteback.writeback(pub.id, 'wb-rl');
    expect(fake.notion.pages.get(pageId)?.system.postelyoNote).toContain('posting limit');

    stack.clock.advance(2 * 60 * 60_000 + 1000);
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'rl2'),
    ).toBe('published');
    expect((await reload(pub.id)).attemptNo).toBe(1);
    stack.clock.advance(-(2 * 60 * 60_000 + 1000));
  });

  // ---------------------------------------------------------------------------
  // Notion webhooks
  // ---------------------------------------------------------------------------

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  const webhook = (body: string, signature?: string) =>
    stack.app.inject({
      method: 'POST',
      url: '/webhooks/notion',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-notion-signature': signature } : {}),
      },
      payload: body,
    });
  const event = (id: string, pageId: string, database = '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40506') =>
    JSON.stringify({
      id,
      timestamp: new Date().toISOString(),
      workspace_id: 'notion-ws',
      type: 'page.properties_updated',
      entity: { id: pageId, type: 'page' },
      data: { parent: { id: database, type: 'database' } },
    });

  it('verifies signatures, stores events once, and syncs the page when the workspace opted in', async () => {
    // Verification handshake is acknowledged but never processed as an event.
    const verify = await webhook(JSON.stringify({ verification_token: 'secret_x' }));
    expect(verify.statusCode).toBe(200);

    expect((await webhook(event('evt-1', 'wh-page-1'))).statusCode).toBe(401);
    expect((await webhook(event('evt-1', 'wh-page-1'), 'sha256=deadbeef')).statusCode).toBe(401);
    expect((await webhook('not json', sign('not json'))).statusCode).toBe(400);

    // Opt-out by default: stored, ignored.
    stack.enqueue.reset();
    const off = await webhook(event('evt-1', 'wh-page-1'), sign(event('evt-1', 'wh-page-1')));
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ outcome: 'ignored:webhooks_disabled' });
    expect(stack.enqueue.syncPages).toHaveLength(0);

    const enable = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { notionWebhooks: true },
    });
    expect(enable.json()).toMatchObject({ notionWebhooks: true });

    fake.notion.upsert('wh-page-1', { status: 'Draft', title: 'Webhook page' });
    const body = event('evt-2', 'wh-page-1');
    const on = await webhook(body, sign(body));
    expect(on.json()).toMatchObject({ outcome: 'enqueued' });
    expect(stack.enqueue.syncPages).toEqual([{ workspaceId, sourceId, pageId: 'wh-page-1' }]);
    const dup = await webhook(body, sign(body));
    expect(dup.json()).toMatchObject({ outcome: 'duplicate' });
    expect(stack.enqueue.syncPages).toHaveLength(1);

    const unknownDb = event('evt-3', 'wh-page-1', 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb');
    expect((await webhook(unknownDb, sign(unknownDb))).json()).toMatchObject({
      outcome: 'ignored:unknown_database',
    });

    const rows = await stack.db.db
      .select()
      .from(webhookEvent)
      .where(eq(webhookEvent.source, 'notion'));
    expect(rows.map((r) => `${r.externalEventId}:${r.outcome}`).sort()).toEqual([
      'evt-1:ignored:webhooks_disabled',
      'evt-2:enqueued',
      'evt-3:ignored:unknown_database',
    ]);
    expect(rows.find((r) => r.externalEventId === 'evt-2')?.workspaceId).toBe(workspaceId);

    // The job syncs exactly that page; a deleted page is treated as archived.
    const summary = await stack.services.notionSync.syncPage(
      workspaceId,
      sourceId,
      'wh-page-1',
      'wh-job',
    );
    expect(summary.pagesSeen).toBe(1);
    expect(summary.actions.mirrored).toBe(1);
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, 'wh-page-1'));
    expect(p?.state).toBe('draft');
    fake.notion.delete('wh-page-1');
    const gone = await stack.services.notionSync.syncPage(
      workspaceId,
      sourceId,
      'wh-page-1',
      'wh-job-2',
    );
    expect(gone.actions.archived).toBe(1);

    // Retention pruning.
    stack.clock.advance(8 * 24 * 60 * 60_000);
    expect(await stack.services.notionWebhooks.prune()).toBeGreaterThanOrEqual(3);
    stack.clock.advance(-8 * 24 * 60 * 60_000);
  });
});
