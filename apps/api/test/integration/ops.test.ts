import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  alertState,
  auditLog,
  contentSource,
  post,
  publication,
  socialAccount,
} from '../../src/infra/db/schema.js';
import { NOTION_GOOD_DB, NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

describe('ops: alerts, token lifecycle, digest, metrics, operator pages', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let accountId: string;
  let adminEmail: string;
  let seq = 0;

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
  };

  /** Scheduled page whose date is already due; returns its publication. */
  const duePub = async (minutesAgo = 1) => {
    const id = `ops-page-${++seq}`;
    fake.notion.upsert(id, {
      status: 'Scheduled',
      title: id,
      publishDate: {
        start: new Date(stack.clock.now().getTime() - minutesAgo * 60_000).toISOString(),
      },
      body: ['ops body'],
    });
    await sync();
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, id));
    const [pub] = await stack.db.db.select().from(publication).where(eq(publication.postId, p!.id));
    return pub!;
  };

  const alertMails = () => stack.mailer.sent.filter((m) => m.to === 'ops@example.com');
  const adminMails = () => stack.mailer.sent.filter((m) => m.to === adminEmail);

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        METRICS_TOKEN: 'metrics-secret-token-1234',
      },
    });
    adminEmail = uniqueEmail('ops-admin');
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(adminEmail));
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = connect.json<{ id: string }>().id;
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    accountId = list.json<{ accounts: { id: string }[] }>().accounts[0]!.id;
    // Alert windows are keyed globally; start each run from a clean slate.
    await stack.db.db.delete(alertState);
  });
  afterAll(async () => {
    await stack.db.db
      .update(publication)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(publication.workspaceId, workspaceId),
          inArray(publication.state, ['scheduled', 'queued', 'retry_wait', 'blocked']),
        ),
      );
    await stack.close();
  });

  it('alerts once per window for an overdue publication and records the alert', async () => {
    const pub = await duePub(1);
    await stack.db.db
      .update(publication)
      .set({ scheduledAt: new Date(stack.clock.now().getTime() - 20 * 60_000) })
      .where(eq(publication.id, pub.id));
    const before = alertMails().length;

    const first = await stack.services.alerts.evaluateWorker('m1');
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const mail = alertMails().find((m) => m.text.includes(pub.id));
    expect(mail?.subject).toContain('publication.overdue');
    expect(mail?.text).toContain(`/w/${workspaceId}/publications/${pub.id}`);
    expect(mail?.text).not.toContain('ops body');

    const second = await stack.services.alerts.evaluateWorker('m2');
    expect(alertMails().filter((m) => m.text.includes(pub.id))).toHaveLength(1);
    expect(second.suppressed).toBeGreaterThanOrEqual(1);

    stack.clock.advance(61 * 60_000);
    await stack.services.alerts.evaluateWorker('m3');
    expect(alertMails().filter((m) => m.text.includes(pub.id))).toHaveLength(2);
    stack.clock.advance(-61 * 60_000);

    const audits = await stack.db.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, 'alert.sent'),
          eq(auditLog.entityId, `publication.overdue:${pub.id}`),
        ),
      );
    expect(audits.length).toBe(2);
    expect(alertMails().length).toBeGreaterThan(before);
    // Withdraw the page in Notion so later syncs do not re-schedule it (a moved date counts as retry intent).
    fake.notion.upsert('ops-page-1', { status: 'Cancelled' });
    await sync();
    expect(
      (await stack.db.db.select().from(publication).where(eq(publication.id, pub.id)))[0]?.state,
    ).toBe('cancelled');
  });

  it('alerts on ambiguous publications, failed writebacks and failing syncs', async () => {
    const amb = await duePub(1);
    await stack.db.db
      .update(publication)
      .set({ state: 'ambiguous', lastErrorMessage: 'timeout' })
      .where(eq(publication.id, amb.id));
    const wb = await duePub(1);
    await stack.db.db
      .update(publication)
      .set({ state: 'published', writebackState: 'failed' })
      .where(eq(publication.id, wb.id));
    await stack.db.db
      .update(contentSource)
      .set({ lastError: 'Notion rate limit reached', status: 'active' })
      .where(eq(contentSource.id, sourceId));

    await stack.services.alerts.evaluateWorker('m4');
    expect(
      alertMails().some(
        (m) => m.subject.includes('publication.ambiguous') && m.text.includes(amb.id),
      ),
    ).toBe(true);
    expect(
      alertMails().some(
        (m) => m.subject.includes('publication.writeback_failed') && m.text.includes(wb.id),
      ),
    ).toBe(true);
    expect(
      alertMails().some(
        (m) => m.subject.includes('content_source.sync_failed') && m.text.includes('rate limit'),
      ),
    ).toBe(true);

    await stack.db.db
      .update(contentSource)
      .set({ lastError: null })
      .where(eq(contentSource.id, sourceId));
  });

  it('the api-side heartbeat check alerts only when the worker is stale', async () => {
    expect(await stack.services.alerts.evaluateHeartbeat('h0')).toBe('unknown');
    await stack.services.heartbeat.beat('worker-1', new Date(), 'test');
    expect(await stack.services.alerts.evaluateHeartbeat('h1')).toBe('ok');
    expect(await stack.services.heartbeat.latestAgeSeconds()).toBeLessThan(5);

    stack.clock.advance(3 * 60_000);
    expect(await stack.services.alerts.evaluateHeartbeat('h2')).toBe('sent');
    expect(alertMails().some((m) => m.subject.includes('worker.heartbeat_missing'))).toBe(true);
    expect(await stack.services.alerts.evaluateHeartbeat('h3')).toBe('suppressed');
    stack.clock.advance(-3 * 60_000);
    await stack.services.heartbeat.beat('worker-1', new Date(), 'test');
    expect(await stack.services.alerts.evaluateHeartbeat('h4')).toBe('ok');
  });

  it('reminds the connecting admin before expiry, exactly once per token', async () => {
    const soon = new Date(stack.clock.now().getTime() + 3 * 24 * 60 * 60_000);
    await stack.db.db
      .update(socialAccount)
      .set({ tokenExpiresAt: soon })
      .where(eq(socialAccount.id, accountId));
    const before = adminMails().length;
    const r1 = await stack.services.tokenExpiry.run('t1');
    expect(r1.reminders).toBe(1);
    const mail = adminMails().at(-1)!;
    expect(mail.subject).toMatch(/expires in 3 days/);
    expect(mail.text).toContain(`/w/${workspaceId}/connections`);
    expect(alertMails().some((m) => m.subject.includes('expires in'))).toBe(false);

    const r2 = await stack.services.tokenExpiry.run('t2');
    expect(r2.reminders).toBe(0);
    expect(adminMails().length).toBe(before + 1);
  });

  it('an expired token marks the account, blocks scheduled publications and notifies the admin', async () => {
    const future = await duePub(-120); // due in two hours, stays scheduled
    expect(future.state).toBe('scheduled');
    await stack.db.db
      .update(socialAccount)
      .set({ tokenExpiresAt: new Date(stack.clock.now().getTime() - 1000), reauthNotifiedAt: null })
      .where(eq(socialAccount.id, accountId));

    const r = await stack.services.tokenExpiry.run('t3');
    expect(r.expired).toBe(1);
    const [acc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, accountId));
    expect(acc?.status).toBe('needs_reauth');
    const [blocked] = await stack.db.db
      .select()
      .from(publication)
      .where(eq(publication.id, future.id));
    expect(blocked?.state).toBe('blocked');
    const mail = adminMails().at(-1)!;
    expect(mail.subject).toContain('has expired');
    expect(mail.text).toContain('1 scheduled post is on hold');

    // No second notice while it stays in needs_reauth.
    const again = await stack.services.tokenExpiry.run('t4');
    expect(again.expired + again.reauthNotices).toBe(0);

    // Reconnecting resets the reminder cycle.
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    const [reconnected] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, accountId));
    expect(reconnected).toMatchObject({
      status: 'active',
      reauthReminderSentAt: null,
      reauthNotifiedAt: null,
    });
  });

  it('notifies the admin once when publishing marks the account needs_reauth', async () => {
    await stack.db.db
      .update(socialAccount)
      .set({ status: 'needs_reauth', reauthNotifiedAt: null })
      .where(eq(socialAccount.id, accountId));
    const r = await stack.services.tokenExpiry.run('t5');
    expect(r.reauthNotices).toBe(1);
    expect(adminMails().at(-1)?.subject).toContain('re-authorize LinkedIn');
    expect((await stack.services.tokenExpiry.run('t6')).reauthNotices).toBe(0);
    await stack.db.db
      .update(socialAccount)
      .set({ status: 'active' })
      .where(eq(socialAccount.id, accountId));
  });

  it('sends the daily digest once per window', async () => {
    expect(await stack.services.digest.run('d1')).toBe('sent');
    const mail = alertMails().at(-1)!;
    expect(mail.subject).toContain('Daily digest');
    expect(mail.text).toMatch(/published \d+, failed \d+, needs review \d+/);
    expect(await stack.services.digest.run('d2')).toBe('suppressed');
  });

  it('exposes metrics behind the bearer token', async () => {
    const denied = await stack.app.inject({ method: 'GET', url: '/metrics' });
    expect(denied.statusCode).toBe(401);
    const ok = await stack.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret-token-1234' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toContain('# TYPE postelyo_publications gauge');
    expect(ok.body).toMatch(/postelyo_publications\{state="[a-z_]+"\} \d+/);
    expect(ok.body).toMatch(/postelyo_worker_heartbeat_age_seconds \d+/);
    expect(ok.body).toContain('postelyo_social_accounts{status="active"}');
  });

  it('renders the posts page and lets an operator retry and resolve from the UI', async () => {
    const failed = await duePub(1);
    await stack.db.db
      .update(publication)
      .set({ state: 'failed', lastErrorCode: 'content', lastErrorMessage: 'rejected' })
      .where(eq(publication.id, failed.id));
    const amb = await duePub(1);
    await stack.db.db
      .update(publication)
      .set({ state: 'ambiguous', lastErrorMessage: 'unknown' })
      .where(eq(publication.id, amb.id));

    const page = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/posts`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Retry now');
    expect(page.body).toContain('Resolve');
    expect(page.body).toContain('rejected');

    const detail = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/publications/${failed.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('Audit trail');
    expect(detail.body).toContain('publication.created');

    const retry = await stack.app.inject({
      method: 'POST',
      url: `/w/${workspaceId}/publications/${failed.id}/retry`,
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    });
    expect(retry.statusCode).toBe(302);
    expect(
      (await stack.db.db.select().from(publication).where(eq(publication.id, failed.id)))[0],
    ).toMatchObject({ state: 'scheduled', cycleNo: failed.cycleNo + 1 });

    const resolve = await stack.app.inject({
      method: 'POST',
      url: `/w/${workspaceId}/publications/${amb.id}/resolve`,
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload:
        'outcome=published&providerPostUrl=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2Fupdate%2Furn%3Ali%3Ashare%3A1',
    });
    expect(resolve.statusCode).toBe(302);
    expect(decodeURIComponent(resolve.headers.location as string)).toContain(
      'Resolved as published',
    );
    expect(
      (await stack.db.db.select().from(publication).where(eq(publication.id, amb.id)))[0],
    ).toMatchObject({
      state: 'published',
      providerPostUrl: 'https://www.linkedin.com/feed/update/urn:li:share:1',
    });

    const stranger = await stack.signInWithWorkspace(uniqueEmail('stranger'));
    const denied = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/posts`,
      headers: { cookie: stranger.cookie },
    });
    expect(denied.statusCode).toBe(404);
  });
});
