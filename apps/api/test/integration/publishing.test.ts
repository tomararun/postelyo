import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { PgBoss } from 'pg-boss';
import { inject } from 'vitest';
import {
  auditLog,
  post,
  publication,
  publishAttempt,
  socialAccount,
} from '../../src/infra/db/schema.js';
import { JOB, PgBossEnqueuer } from '../../src/infra/queue.js';
import { registerPublishJob } from '../../src/jobs/publish.job.js';
import { registerWritebackJob } from '../../src/jobs/writeback.job.js';
import { PublishEngine } from '../../src/modules/publishing/engine.js';
import type { FakeProvider } from '../../src/modules/publishing/providers/fake/fake-provider.js';
import { NOTION_GOOD_DB, NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, uniqueEmail, waitFor, type TestStack } from './helpers.js';

describe('scheduling and publishing', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let accountId: string;
  let provider: FakeProvider;
  let pageSeq = 0;

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
  };

  /** Creates a Scheduled Notion page whose date is already due (within the 10-minute grace). */
  const scheduleDuePage = async (body = 'Hello LinkedIn') => {
    const id = `pub-page-${++pageSeq}`;
    const due = new Date(stack.clock.now().getTime() - 60_000).toISOString();
    fake.notion.upsert(id, {
      status: 'Scheduled',
      title: id,
      publishDate: { start: due },
      body: [body],
    });
    await sync();
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, id));
    const [pub] = await stack.db.db.select().from(publication).where(eq(publication.postId, p!.id));
    expect(pub?.state).toBe('scheduled');
    return { pageId: id, post: p!, pub: pub! };
  };

  const reloadPub = async (id: string) =>
    (await stack.db.db.select().from(publication).where(eq(publication.id, id)))[0]!;

  const connectLinkedIn = async () => {
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
    return list.json<{ accounts: { id: string }[] }>().accounts[0]!.id;
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: { LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret' },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('pub')));
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = connect.json<{ id: string }>().id;
    accountId = await connectLinkedIn();
    provider = stack.services.providers.get('linkedin') as FakeProvider;
  });
  afterAll(async () => {
    await stack.close();
  });

  it('dispatches due publications, publishes once, records the attempt and writes results back', async () => {
    const { pageId, pub } = await scheduleDuePage('First real post #launch');
    stack.enqueue.reset();

    const tick = await stack.services.scheduler.tick('t1');
    expect(tick.dispatched).toBe(1);
    expect(tick.maxLagSeconds).toBeGreaterThanOrEqual(59);
    expect((await reloadPub(pub.id)).state).toBe('queued');
    expect(stack.enqueue.published.map((p) => p.data.publicationId)).toEqual([pub.id]);

    const calls = provider.calls.length;
    const outcome = await stack.services.engine.handle(
      { publicationId: pub.id, cycleNo: pub.cycleNo },
      'c1',
    );
    expect(outcome).toBe('published');
    expect(provider.calls.length).toBe(calls + 1);
    expect(provider.calls.at(-1)?.input.content.text).toContain('First real post');

    const after = await reloadPub(pub.id);
    expect(after).toMatchObject({
      state: 'published',
      attemptNo: 1,
      leaseOwner: null,
      writebackState: 'pending',
    });
    expect(after.providerPostId).toMatch(/^fake:/);
    expect(after.delaySeconds).toBeGreaterThanOrEqual(59);
    expect(after.publishedAt).toBeInstanceOf(Date);

    const attempts = await stack.db.db
      .select()
      .from(publishAttempt)
      .where(eq(publishAttempt.publicationId, pub.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptNo: 1,
      outcome: 'succeeded',
      workerId: 'test-worker',
    });
    expect(attempts[0]?.delaySeconds).toBe(after.delaySeconds);

    const [p] = await stack.db.db.select().from(post).where(eq(post.id, pub.postId));
    expect(p?.state).toBe('published');

    const trail = await stack.db.db
      .select({ from: auditLog.fromState, to: auditLog.toState })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, pub.id), eq(auditLog.event, 'publication.state_changed')))
      .orderBy(auditLog.occurredAt);
    expect(trail.map((t) => `${t.from}→${t.to}`)).toEqual([
      'scheduled→queued',
      'queued→publishing',
      'publishing→published',
    ]);

    expect(
      stack.enqueue.writebacks.filter((w) => w.publicationId === pub.id).length,
    ).toBeGreaterThanOrEqual(1);
    const wb = await stack.services.resultWriteback.writeback(pub.id, 'wb1');
    expect(wb).toBe('done');
    const page = fake.notion.pages.get(pageId)!;
    expect(page.system.postelyoStatus).toBe('Published');
    expect(page.system.publishedUrl).toBe(after.providerPostUrl);
    expect(page.system.publishedAt).toBe(after.publishedAt!.toISOString());
    expect(page.system.postelyoId).toBe(pub.id);
    expect((await reloadPub(pub.id)).writebackState).toBe('done');

    // A second tick finds nothing due and does not touch the published row.
    const again = await stack.services.scheduler.tick('t2');
    expect(again.dispatched).toBe(0);
    expect((await reloadPub(pub.id)).state).toBe('published');
  });

  it('two workers racing for the same job produce exactly one provider call', async () => {
    const { pub } = await scheduleDuePage('Race me');
    await stack.services.scheduler.tick('t-race');
    const rival = new PublishEngine({
      db: stack.db.db,
      providers: stack.services.providers,
      socialAccounts: stack.services.socialAccounts,
      media: stack.services.media,
      enqueue: stack.enqueue,
      clock: stack.clock,
      logger: pino({ level: 'silent' }),
      workerId: 'rival-worker',
    });
    const before = provider.calls.length;
    const job = { publicationId: pub.id, cycleNo: pub.cycleNo };
    const outcomes = await Promise.all([
      stack.services.engine.handle(job, 'r1'),
      rival.handle(job, 'r2'),
      stack.services.engine.handle(job, 'r3'),
    ]);
    expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    expect(provider.calls.length).toBe(before + 1);
    const after = await reloadPub(pub.id);
    expect(after.state).toBe('published');
    expect(after.attemptNo).toBe(1);
    // Replaying the job after success is also a no-op.
    expect(await stack.services.engine.handle(job, 'r4')).toBe('skipped');
    expect(provider.calls.length).toBe(before + 1);
  });

  it('retries transient errors with backoff and succeeds on the next attempt', async () => {
    const { pub } = await scheduleDuePage('Flaky network');
    await stack.services.scheduler.tick('t-retry');
    stack.enqueue.reset();
    provider.scriptOutcomes({
      kind: 'retryable_error',
      reason: '503 from provider',
      retryAfterMs: 45_000,
    });

    const first = await stack.services.engine.handle(
      { publicationId: pub.id, cycleNo: pub.cycleNo },
      'x1',
    );
    expect(first).toBe('retry_scheduled');
    let row = await reloadPub(pub.id);
    expect(row.state).toBe('retry_wait');
    expect(row.lastErrorCode).toBe('transient');
    expect(row.nextAttemptAt!.getTime() - stack.clock.now().getTime()).toBeGreaterThan(40_000);
    const retryJob = stack.enqueue.published.find((p) => p.data.publicationId === pub.id);
    expect(retryJob?.startAfter?.getTime()).toBe(row.nextAttemptAt!.getTime());

    // Too early: the lease is refused because next_attempt_at is in the future.
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'x2'),
    ).toBe('skipped');

    stack.clock.advance(46_000);
    const second = await stack.services.engine.handle(
      { publicationId: pub.id, cycleNo: pub.cycleNo },
      'x3',
    );
    expect(second).toBe('published');
    row = await reloadPub(pub.id);
    expect(row.attemptNo).toBe(2);
    const attempts = await stack.db.db
      .select()
      .from(publishAttempt)
      .where(eq(publishAttempt.publicationId, pub.id));
    expect(attempts.map((a) => a.outcome).sort()).toEqual(['failed_retryable', 'succeeded']);
  });

  it('gives up after max attempts and reports Failed to Notion', async () => {
    const { pageId, pub } = await scheduleDuePage('Always flaky');
    await stack.services.scheduler.tick('t-giveup');
    for (let i = 0; i < pub.maxAttempts; i++) {
      provider.scriptOutcomes({ kind: 'retryable_error', reason: `flake ${i + 1}` });
      const outcome = await stack.services.engine.handle(
        { publicationId: pub.id, cycleNo: pub.cycleNo },
        `g${i}`,
      );
      if (i < pub.maxAttempts - 1) {
        expect(outcome).toBe('retry_scheduled');
        stack.clock.advance(16 * 60_000);
      } else {
        expect(outcome).toBe('failed');
      }
    }
    const row = await reloadPub(pub.id);
    expect(row.state).toBe('failed');
    expect(row.attemptNo).toBe(pub.maxAttempts);
    expect(row.lastErrorMessage).toContain(`Gave up after ${pub.maxAttempts} attempts`);
    await stack.services.resultWriteback.writeback(pub.id, 'wb');
    expect(fake.notion.pages.get(pageId)?.system.postelyoStatus).toBe('Failed');
    expect(fake.notion.pages.get(pageId)?.system.postelyoNote).toContain(
      'set Status to Scheduled to retry',
    );
  });

  it('terminal content errors fail immediately without retry', async () => {
    const { pub } = await scheduleDuePage('Bad content');
    await stack.services.scheduler.tick('t-content');
    provider.scriptOutcomes({
      kind: 'terminal_error',
      code: 'content',
      reason: 'commentary rejected',
    });
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'c'),
    ).toBe('failed');
    const row = await reloadPub(pub.id);
    expect(row).toMatchObject({ state: 'failed', lastErrorCode: 'content', attemptNo: 1 });
    expect(row.lastErrorMessage).toContain('commentary rejected');
    const [p] = await stack.db.db.select().from(post).where(eq(post.id, pub.postId));
    expect(p?.state).toBe('failed');
  });

  it('auth errors mark the account for re-authorization and block its other scheduled publications', async () => {
    const due = await scheduleDuePage('Auth fails');
    // A second, future publication on the same account.
    const futureId = `pub-page-future-${++pageSeq}`;
    fake.notion.upsert(futureId, {
      status: 'Scheduled',
      publishDate: { start: new Date(stack.clock.now().getTime() + 3_600_000).toISOString() },
      body: ['later'],
    });
    await sync();
    const [futurePost] = await stack.db.db.select().from(post).where(eq(post.externalId, futureId));
    const [futurePub] = await stack.db.db
      .select()
      .from(publication)
      .where(eq(publication.postId, futurePost!.id));
    expect(futurePub?.state).toBe('scheduled');

    await stack.services.scheduler.tick('t-auth');
    provider.scriptOutcomes({ kind: 'terminal_error', code: 'auth', reason: 'token expired' });
    expect(
      await stack.services.engine.handle(
        { publicationId: due.pub.id, cycleNo: due.pub.cycleNo },
        'a',
      ),
    ).toBe('failed');

    expect(await reloadPub(due.pub.id)).toMatchObject({ state: 'failed', lastErrorCode: 'auth' });
    expect((await reloadPub(futurePub!.id)).state).toBe('blocked');
    const [acc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, accountId));
    expect(acc?.status).toBe('needs_reauth');

    // Blocked rows are never dispatched.
    stack.clock.advance(2 * 3_600_000);
    const tick = await stack.services.scheduler.tick('t-auth-2');
    expect(tick.dispatched).toBe(0);

    // Restore the account for the remaining tests (reconnect would do the same),
    // and withdraw the future page so it does not become due in later tests.
    await stack.db.db
      .update(socialAccount)
      .set({ status: 'active' })
      .where(eq(socialAccount.id, accountId));
    stack.clock.advance(-2 * 3_600_000);
    fake.notion.upsert(futureId, { status: 'Cancelled' });
    await sync();
    expect((await reloadPub(futurePub!.id)).state).toBe('cancelled');
  });

  it('ambiguous outcomes stop, are never retried, and can be resolved by an operator', async () => {
    const { pageId, pub } = await scheduleDuePage('Unknown outcome');
    await stack.services.scheduler.tick('t-amb');
    provider.scriptOutcomes({ kind: 'ambiguous', reason: 'timeout after send' });
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'm'),
    ).toBe('ambiguous');
    let row = await reloadPub(pub.id);
    expect(row.state).toBe('ambiguous');

    stack.enqueue.reset();
    stack.clock.advance(60 * 60_000);
    await stack.services.scheduler.tick('t-amb-2');
    // Neither the dispatcher nor the stale sweeper ever touches an ambiguous row.
    expect(stack.enqueue.published.filter((p) => p.data.publicationId === pub.id)).toHaveLength(0);
    expect((await reloadPub(pub.id)).state).toBe('ambiguous');
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'm2'),
    ).toBe('skipped');

    await stack.services.resultWriteback.writeback(pub.id, 'wb');
    expect(fake.notion.pages.get(pageId)?.system.postelyoStatus).toBe('Needs review');

    const bad = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/publications/${pub.id}/retry`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(409);

    const resolved = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/publications/${pub.id}/resolve`,
      headers: { cookie },
      payload: {
        outcome: 'published',
        providerPostId: 'urn:li:share:999',
        providerPostUrl: 'https://www.linkedin.com/feed/update/urn:li:share:999',
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      state: 'published',
      providerPostId: 'urn:li:share:999',
    });
    row = await reloadPub(pub.id);
    expect(row.state).toBe('published');
    expect(stack.enqueue.writebacks.some((w) => w.publicationId === pub.id)).toBe(true);
    await stack.services.resultWriteback.writeback(pub.id, 'wb2');
    expect(fake.notion.pages.get(pageId)?.system.postelyoStatus).toBe('Published late');
    stack.clock.advance(-60 * 60_000);
  });

  it('expired leases become ambiguous, never queued', async () => {
    const { pub } = await scheduleDuePage('Worker died');
    await stack.services.scheduler.tick('t-lease');
    await stack.db.db
      .update(publication)
      .set({
        state: 'publishing',
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(stack.clock.now().getTime() - 1000),
        attemptNo: 1,
      })
      .where(eq(publication.id, pub.id));
    stack.enqueue.reset();
    const tick = await stack.services.scheduler.tick('t-lease-2');
    expect(tick.leasesExpired).toBe(1);
    const row = await reloadPub(pub.id);
    expect(row.state).toBe('ambiguous');
    expect(row.lastErrorMessage).toContain('dead-worker');
    expect(stack.enqueue.published).toHaveLength(0);
    expect(stack.enqueue.writebacks.map((w) => w.publicationId)).toContain(pub.id);
  });

  it('re-sends stale queued jobs idempotently', async () => {
    const { pub } = await scheduleDuePage('Lost job');
    await stack.services.scheduler.tick('t-stale');
    stack.enqueue.reset();
    expect((await stack.services.scheduler.tick('t-stale-2')).requeued).toBe(0);
    stack.clock.advance(3 * 60_000);
    const tick = await stack.services.scheduler.tick('t-stale-3');
    expect(tick.requeued).toBeGreaterThanOrEqual(1);
    expect(stack.enqueue.published.map((p) => p.data.publicationId)).toContain(pub.id);
    stack.clock.advance(-3 * 60_000);
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 's'),
    ).toBe('published');
  });

  it('publishes late after an outage and reports the delay', async () => {
    const { pageId, pub } = await scheduleDuePage('Late post');
    await stack.db.db
      .update(publication)
      .set({ scheduledAt: new Date(stack.clock.now().getTime() - 2 * 3_600_000) })
      .where(eq(publication.id, pub.id));
    await stack.services.scheduler.tick('t-late');
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'l'),
    ).toBe('published');
    const row = await reloadPub(pub.id);
    expect(row.delaySeconds).toBeGreaterThanOrEqual(7_190);
    expect(row.delaySeconds).toBeLessThan(7_300);
    await stack.services.resultWriteback.writeback(pub.id, 'wb');
    const page = fake.notion.pages.get(pageId)!;
    expect(page.system.postelyoStatus).toBe('Published late');
    expect(page.system.postelyoNote).toMatch(/12\d min late/);
  });

  it('operator retry of a failed publication starts a new cycle that publishes', async () => {
    const { pub } = await scheduleDuePage('Retry me');
    await stack.services.scheduler.tick('t-op');
    provider.scriptOutcomes({ kind: 'terminal_error', code: 'content', reason: 'nope' });
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'o1'),
    ).toBe('failed');

    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/publications/${pub.id}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'scheduled',
      cycleNo: pub.cycleNo + 1,
      attemptNo: 0,
    });

    // The old cycle's job must not be able to claim the new cycle.
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo }, 'o2'),
    ).toBe('skipped');
    const tick = await stack.services.scheduler.tick('t-op-2');
    expect(tick.dispatched).toBe(1);
    expect(
      await stack.services.engine.handle({ publicationId: pub.id, cycleNo: pub.cycleNo + 1 }, 'o3'),
    ).toBe('published');
    const detail = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/publications/${pub.id}`,
      headers: { cookie },
    });
    const dto = detail.json<{ state: string; attempts: { cycleNo: number; outcome: string }[] }>();
    expect(dto.state).toBe('published');
    expect(dto.attempts.map((a) => `${a.cycleNo}:${a.outcome}`)).toEqual([
      `${pub.cycleNo}:failed_terminal`,
      `${pub.cycleNo + 1}:succeeded`,
    ]);
  });

  it('runs end to end through real pg-boss queues (publish and writeback jobs)', async () => {
    const boss = new PgBoss({ connectionString: inject('databaseUrl'), schema: 'pgboss_test' });
    await boss.start();
    for (const name of [JOB.publish, JOB.writeback])
      await boss.createQueue(name, { policy: 'stately' });
    const enqueuer = new PgBossEnqueuer(boss);
    const logger = pino({ level: 'silent' });
    const engine = new PublishEngine({
      db: stack.db.db,
      providers: stack.services.providers,
      socialAccounts: stack.services.socialAccounts,
      media: stack.services.media,
      enqueue: enqueuer,
      clock: stack.clock,
      logger,
      workerId: 'boss-worker',
    });
    await registerPublishJob(boss, engine, logger);
    await registerWritebackJob(boss, stack.services.resultWriteback, logger);
    try {
      const { pageId, pub } = await scheduleDuePage('Through the queue');
      await stack.db.db
        .update(publication)
        .set({ state: 'queued', queuedAt: stack.clock.now() })
        .where(eq(publication.id, pub.id));
      await enqueuer.publish({ publicationId: pub.id, cycleNo: pub.cycleNo });
      await enqueuer.publish({ publicationId: pub.id, cycleNo: pub.cycleNo }); // duplicate send is a no-op
      const published = await waitFor(async () => {
        const row = await reloadPub(pub.id);
        return row.state === 'published' ? row : null;
      });
      expect(published.attemptNo).toBe(1);
      await waitFor(async () => (await reloadPub(pub.id)).writebackState === 'done');
      expect(fake.notion.pages.get(pageId)?.system.postelyoStatus).toBe('Published');
    } finally {
      await boss.stop({ graceful: false, timeout: 2000 });
    }
  }, 40_000);
});
