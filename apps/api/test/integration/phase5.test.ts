import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import type { FakeProvider } from '@postelyo/publishing-core';
import {
  auditLog,
  membership,
  post,
  publication,
  publicationMetric,
} from '../../src/infra/db/schema.js';
import { runMaintenance } from '../../src/jobs/maintenance.job.js';
import {
  METRIC_TIERS_MS,
  METRICS_MAX_ATTEMPTS,
} from '../../src/modules/analytics/metrics.service.js';
import { hashtagsIn, isoWeek } from '../../src/modules/analytics/analytics-query.service.js';
import { createFakeProviders } from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Phase 5 analytics: decaying metrics fetches on their own queue, per-post
 * writeback, Analytics database rollups, weekly report, dashboard summary
 * (top posts, hashtags, best times) and the opt-out. All through the fakes.
 */
describe('phase 5 analytics', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let analyticsDb: string;
  let provider: FakeProvider;
  let seq = 0;

  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    stack.app.inject({
      method,
      url,
      headers: { cookie, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const sync = async () => {
    const res = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      {},
    );
    expect([200, 207]).toContain(res.statusCode);
  };
  // Fake page ids repeat across suites sharing the database; scope by workspace.
  const postByPage = async (pageId: string) =>
    (
      await stack.db.db
        .select()
        .from(post)
        .where(and(eq(post.externalId, pageId), eq(post.workspaceId, workspaceId)))
    )[0]!;
  const pubsOf = async (postId: string) =>
    stack.db.db.select().from(publication).where(eq(publication.postId, postId));
  const publishAll = async (pubs: { id: string; cycleNo: number }[]) => {
    await stack.services.scheduler.tick(`p5-${++seq}`);
    for (const p of pubs) {
      await stack.services.engine.handle(
        { publicationId: p.id, cycleNo: p.cycleNo },
        `p5-run-${++seq}`,
      );
    }
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
        engine: stack.services.engine,
        postMetrics: stack.services.postMetrics,
        analyticsWriteback: stack.services.analyticsWriteback,
        weeklyReport: stack.services.weeklyReport,
      },
      `maint-p5-${++seq}`,
      pino({ level: 'silent' }),
    );
  const publishedPost = async (pageId: string, body: string, minutesAgo = 1) => {
    fake.notion.upsert(pageId, {
      status: 'Scheduled',
      title: pageId,
      platforms: ['LinkedIn'],
      publishDate: {
        start: new Date(stack.clock.now().getTime() - minutesAgo * 60_000).toISOString(),
      },
      body: [body],
    });
    await sync();
    const row = await postByPage(pageId);
    const pubs = await pubsOf(row.id);
    await publishAll(pubs);
    return { post: row, pub: (await pubsOf(row.id))[0]! };
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        NOTION_CLIENT_ID: 'notion-client',
        NOTION_CLIENT_SECRET: 'notion-secret',
      },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p5')));
    await stack.grantPlan(workspaceId, 'agency');
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
    const done = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
      {
        mode: 'create',
        parentPageId: parent,
      },
    );
    analyticsDb = done.json<{ analyticsDatabaseId: string }>().analyticsDatabaseId;
    const li = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
    );
    const liState = new URL(li.headers.location as string).searchParams.get('state')!;
    await inject('GET', `/oauth/linkedin/callback?code=good-code&state=${liState}`);
    provider = stack.services.providers.get('linkedin') as FakeProvider;
  });
  afterAll(async () => {
    await stack.close();
  });

  it('creates the Analytics database with the template suite', () => {
    expect(analyticsDb).toBeTruthy();
    const db = fake.notion.createdDatabases.get(analyticsDb) as {
      properties: Record<string, { type: string }>;
    };
    expect(db.properties['Engagement Rate']?.type).toBe('number');
    expect(db.properties['Best Time']?.type).toBe('rich_text');
    const content = fake.notion.createdDatabases.get(
      (fake.notion.createdDatabases.size, [...fake.notion.createdDatabases.keys()].at(-1)!),
    ) as { properties: Record<string, { type: string }> };
    expect(content.properties['Impressions']?.type).toBe('number');
    expect(content.properties['Metrics Updated']?.type).toBe('date');
  });

  it('schedules the first fetch after publishing and walks the tiers, writing per-post columns', async () => {
    const { post: row, pub } = await publishedPost('p5-one', 'first post #launch #tips');
    expect(pub.state).toBe('published');
    expect(pub.metricsTier).toBe(0);
    expect(pub.metricsNextAt!.getTime()).toBe(pub.publishedAt!.getTime() + METRIC_TIERS_MS[0]!);
    const job = stack.enqueue.metricFetches.at(-1)!;
    expect(job.data.publicationId).toBe(pub.id);
    expect(job.startAfter?.getTime()).toBe(pub.metricsNextAt!.getTime());

    // Too early: the fetch defers itself.
    stack.enqueue.metricFetches.length = 0;
    expect(await stack.services.postMetrics.fetch(pub.id, 'early')).toBe('rescheduled');
    expect(stack.enqueue.metricFetches).toHaveLength(1);

    // At +1h the first tier is stored and the next one scheduled at +6h.
    stack.clock.advance(METRIC_TIERS_MS[0]! + 1000);
    stack.enqueue.metricFetches.length = 0;
    expect(await stack.services.postMetrics.fetch(pub.id, 'tier0')).toBe('fetched');
    let rows = await stack.db.db
      .select()
      .from(publicationMetric)
      .where(eq(publicationMetric.publicationId, pub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 0,
      impressions: 100,
      reactions: 10,
      comments: 2,
      shares: 1,
      clicks: 5,
    });
    let [fresh] = await pubsOf(row.id);
    expect(fresh!.metricsTier).toBe(1);
    expect(fresh!.metricsNextAt!.getTime()).toBe(pub.publishedAt!.getTime() + METRIC_TIERS_MS[1]!);
    expect(stack.enqueue.metricFetches.at(-1)!.startAfter!.getTime()).toBe(
      fresh!.metricsNextAt!.getTime(),
    );
    // Notion columns received the numbers.
    const page = fake.notion.pages.get('p5-one')!;
    expect(page.extra['Impressions']).toBe(100);
    expect(page.extra['Reactions']).toBe(10);
    expect(typeof page.extra['Metrics Updated']).toBe('string');

    // Walk the remaining tiers; each stores its own snapshot; the last one ends the schedule.
    for (let tier = 1; tier < METRIC_TIERS_MS.length; tier++) {
      stack.clock.advance(METRIC_TIERS_MS[tier]! - METRIC_TIERS_MS[tier - 1]!);
      expect(await stack.services.postMetrics.fetch(pub.id, `tier${tier}`)).toBe('fetched');
    }
    rows = await stack.db.db
      .select()
      .from(publicationMetric)
      .where(eq(publicationMetric.publicationId, pub.id));
    expect(rows.map((r) => r.tier).sort()).toEqual([0, 1, 2, 3, 4]);
    [fresh] = await pubsOf(row.id);
    expect(fresh!.metricsTier).toBe(5);
    expect(fresh!.metricsNextAt).toBeNull();
    expect(await stack.services.postMetrics.fetch(pub.id, 'after')).toBe('skipped');
    expect(page.extra['Impressions']).toBe(500);

    // Idempotent snapshot per tier: the latest fetch replaces, never duplicates.
    const detail = await inject('GET', `/v1/workspaces/${workspaceId}/publications/${pub.id}`);
    const dto = detail.json<{
      metrics: { tier: string; impressions: number }[];
      metricsTier: number;
    }>();
    expect(dto.metrics.map((m) => m.tier)).toEqual(['1h', '6h', '24h', '7d', '30d']);
    expect(dto.metricsTier).toBe(5);
    const audits = await stack.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'metrics.fetched'));
    expect(audits.filter((a) => a.entityId === pub.id)).toHaveLength(5);
  });

  it('reschedules on retryable failures, stops on permanent ones and after too many attempts', async () => {
    const { pub } = await publishedPost('p5-retry', 'retry post');
    stack.clock.advance(METRIC_TIERS_MS[0]! + 1000);
    provider.metricsDecide = () => ({
      kind: 'unavailable',
      reason: 'rate limited',
      retryable: true,
      retryAfterMs: 5 * 60_000,
    });
    try {
      stack.enqueue.metricFetches.length = 0;
      expect(await stack.services.postMetrics.fetch(pub.id, 'rl')).toBe('rescheduled');
      let [fresh] = await pubsOf(pub.postId);
      expect(fresh!.metricsAttempts).toBe(1);
      expect(fresh!.metricsError).toBe('rate limited');
      expect(fresh!.metricsTier).toBe(0);
      expect(
        Math.abs(
          stack.enqueue.metricFetches.at(-1)!.startAfter!.getTime() -
            (stack.clock.now().getTime() + 5 * 60_000),
        ),
      ).toBeLessThan(1000);
      // Attempts are bounded.
      for (let i = 1; i < METRICS_MAX_ATTEMPTS; i++) {
        stack.clock.advance(6 * 60_000);
        await stack.services.postMetrics.fetch(pub.id, `rl-${i}`);
      }
      [fresh] = await pubsOf(pub.postId);
      expect(fresh!.metricsNextAt).toBeNull();
      expect(fresh!.metricsError).toContain('gave up');

      // Permanent failure stops immediately.
      const { pub: pub2 } = await publishedPost('p5-perm', 'permanent');
      stack.clock.advance(METRIC_TIERS_MS[0]! + 1000);
      provider.metricsDecide = () => ({
        kind: 'unavailable',
        reason: 'missing permission',
        retryable: false,
      });
      expect(await stack.services.postMetrics.fetch(pub2.id, 'perm')).toBe('stopped');
      const [p2] = await pubsOf(pub2.postId);
      expect(p2!.metricsNextAt).toBeNull();
      expect(p2!.metricsError).toBe('missing permission');
      const stops = await stack.db.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'metrics.stopped'));
      expect(stops.some((s) => s.entityId === pub2.id)).toBe(true);
    } finally {
      provider.metricsDecide = null;
    }
  });

  it('backfills published posts that have no schedule and prunes old snapshots', async () => {
    const { pub } = await publishedPost('p5-backfill', 'backfill');
    // Simulate a pre-Phase-5 row: no schedule at all.
    await stack.db.db
      .update(publication)
      .set({
        metricsNextAt: null,
        metricsTier: 0,
        publishedAt: new Date(stack.clock.now().getTime() - 3 * 86_400_000),
      })
      .where(eq(publication.id, pub.id));
    stack.enqueue.metricFetches.length = 0;
    await maintenance();
    const [fresh] = await pubsOf(pub.postId);
    // Three days old → starts at the 7d tier.
    expect(fresh!.metricsTier).toBe(3);
    expect(fresh!.metricsNextAt).not.toBeNull();
    expect(stack.enqueue.metricFetches.some((j) => j.data.publicationId === pub.id)).toBe(true);
    expect(await stack.services.postMetrics.fetch(pub.id, 'bf')).toBe('fetched');

    // Retention: a snapshot older than 400 days is pruned.
    await stack.db.db
      .update(publicationMetric)
      .set({ fetchedAt: new Date(stack.clock.now().getTime() - 401 * 86_400_000) })
      .where(eq(publicationMetric.publicationId, pub.id));
    expect(await stack.services.postMetrics.prune()).toBeGreaterThanOrEqual(1);
  });

  it('summarises weeks, top posts, hashtags and best times for the dashboard', async () => {
    expect(
      hashtagsIn({
        v: 1,
        blocks: [
          {
            type: 'paragraph',
            inlines: [{ t: 'text', text: 'Go #Launch and #tips, not email#x' }],
          },
        ],
        media: [],
        meta: { source: 'notion' },
      }),
    ).toEqual(['launch', 'tips']);
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'), 'UTC')).toEqual({
      week: '2026-W01',
      weekStart: '2025-12-29',
    });
    expect(isoWeek(new Date('2026-09-27T23:30:00Z'), 'Europe/Berlin')).toEqual({
      week: '2026-W40',
      weekStart: '2026-09-28',
    });

    // A second post with the same hashtag so hashtag stats have two samples.
    const { pub } = await publishedPost('p5-two', 'second post #tips');
    stack.clock.advance(METRIC_TIERS_MS[0]! + 1000);
    await stack.services.postMetrics.fetch(pub.id, 't');

    // The tier walk above moved the clock a month ahead; look back far enough to see both posts.
    const res = await inject('GET', `/v1/workspaces/${workspaceId}/analytics?weeks=12`);
    expect(res.statusCode).toBe(200);
    const s = res.json<{
      weeks: {
        week: string;
        platform: string;
        posts: number;
        impressions: number | null;
        engagementRate: number | null;
      }[];
      topPosts: { title: string; engagement: number }[];
      hashtags: { hashtag: string; posts: number }[];
      bestTimes: { basis: string; slots: { weekday: number; hour: number }[] };
    }>();
    const all = s.weeks.filter((w) => w.platform === 'all' && w.posts > 0);
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.reduce((n, w) => n + w.posts, 0)).toBeGreaterThanOrEqual(2);
    expect(s.weeks.some((w) => w.platform === 'linkedin')).toBe(true);
    expect(s.topPosts[0]!.title).toBe('p5-one'); // 30d snapshot has the biggest numbers
    expect(s.hashtags.find((h) => h.hashtag === 'tips')?.posts).toBe(2);
    expect(s.bestTimes.basis).toBe('defaults');
    expect(s.bestTimes.slots).toHaveLength(3);
  });

  it('writes weekly rollups and best times to the Analytics database idempotently', async () => {
    const r1 = await stack.services.analyticsWriteback.run('aw-1', true);
    // Other suites' workspaces share the database; at least this one is written.
    expect(r1.sources).toBeGreaterThanOrEqual(1);
    expect(r1.rowsWritten).toBeGreaterThanOrEqual(2);
    const rows = [...fake.notion.pages.values()].filter((p) => p.databaseId === analyticsDb);
    const best = rows.find((p) => p.title === 'Best times to publish')!;
    expect(String(best.extra['Best Time'])).toContain('Platform defaults');
    const week = rows.find(
      (p) => p.extra['Platform'] === 'All' && (p.extra['Posts'] as number) > 0,
    )!;
    expect(week.extra['Impressions']).toBeGreaterThan(0);
    // Unchanged numbers are not rewritten; changed ones update the same page.
    const before = fake.notion.patches.length;
    const r2 = await stack.services.analyticsWriteback.run('aw-2', true);
    expect(r2.rowsWritten).toBe(0);
    expect(fake.notion.patches.length).toBe(before);
    const { pub } = await publishedPost('p5-three', 'third');
    stack.clock.advance(METRIC_TIERS_MS[0]! + 1000);
    await stack.services.postMetrics.fetch(pub.id, 't3');
    const r3 = await stack.services.analyticsWriteback.run('aw-3', true);
    expect(r3.rowsWritten).toBeGreaterThanOrEqual(1);
    expect([...fake.notion.pages.values()].filter((p) => p.databaseId === analyticsDb).length).toBe(
      rows.length,
    );
  });

  it('sends the weekly report on Monday morning to owners and admins who did not opt out, once per week', async () => {
    // Move the clock to the next Monday 09:00 UTC (workspace time zone is UTC).
    const now = stack.clock.now();
    const day = now.getUTCDay();
    const daysToMonday = (8 - day) % 7 || 7;
    const monday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday, 9, 0, 0),
    );
    stack.clock.advance(monday.getTime() - now.getTime());
    const sentBefore = (
      await stack.db.db.select().from(auditLog).where(eq(auditLog.event, 'report.weekly_sent'))
    ).filter((a) => a.workspaceId === workspaceId).length;
    stack.mailer.sent.length = 0;
    await maintenance();
    const me = await inject('GET', '/v1/me');
    const email = me.json<{ user: { email: string } }>().user.email;
    const mail = stack.mailer.sent.find(
      (m) => m.to === email && m.subject.includes('Weekly report'),
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain('Posts published:');
    expect(mail!.text).toContain('Best times:');
    expect(mail!.text).toContain(`/w/${workspaceId}/analytics`);
    // Only once per week.
    stack.mailer.sent.length = 0;
    stack.clock.advance(60 * 60_000);
    await maintenance();
    expect(
      stack.mailer.sent.some((m) => m.to === email && m.subject.includes('Weekly report')),
    ).toBe(false);

    // Opt out, then next Monday nothing arrives for this user.
    const pref = await inject('PATCH', `/v1/workspaces/${workspaceId}/members/me`, {
      weeklyReport: false,
    });
    expect(pref.statusCode).toBe(200);
    const members = await inject('GET', `/v1/workspaces/${workspaceId}/members`);
    expect(members.json<{ members: { weeklyReport: boolean }[] }>().members[0]!.weeklyReport).toBe(
      false,
    );
    const [m] = await stack.db.db
      .select()
      .from(membership)
      .where(eq(membership.workspaceId, workspaceId));
    expect(m!.weeklyReport).toBe(false);
    stack.clock.advance(7 * 86_400_000);
    stack.mailer.sent.length = 0;
    await maintenance();
    expect(
      stack.mailer.sent.some((m2) => m2.to === email && m2.subject.includes('Weekly report')),
    ).toBe(false);
    const audits = await stack.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'report.weekly_sent'));
    expect(audits.filter((a) => a.workspaceId === workspaceId)).toHaveLength(sentBefore + 1);
  });

  it('exposes the real adapters against recorded fixtures through the fake HTTP layer', async () => {
    const { LinkedInProvider, XProvider, FacebookProvider, InstagramProvider } =
      await import('@postelyo/publishing-core');
    const ctx = { credentials: { accessToken: 't' }, correlationId: 'c', timeoutMs: 5000 };
    const base = { id: 'a', workspaceId: 'w', displayName: 'n', providerAccountId: '1001' };
    const li = new LinkedInProvider({ fetchImpl: fake.fetchImpl });
    const org = await li.metrics(
      {
        publicationId: 'p',
        providerPostId: 'urn:li:share:1',
        account: { ...base, provider: 'linkedin', accountType: 'organization' },
      },
      ctx,
    );
    expect(org).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: 1200, reactions: 40, clicks: 25 },
    });
    const member = await li.metrics(
      {
        publicationId: 'p',
        providerPostId: 'urn:li:share:1',
        account: { ...base, provider: 'linkedin', accountType: 'member' },
      },
      ctx,
    );
    expect(member).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: null, reactions: 12, comments: 2 },
    });
    const x = await new XProvider({ fetchImpl: fake.fetchImpl }).metrics(
      {
        publicationId: 'p',
        providerPostId: '123',
        account: { ...base, provider: 'x', accountType: 'member' },
      },
      ctx,
    );
    expect(x).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: 2500, reactions: 30, comments: 3, shares: 5, clicks: 40, saves: 2 },
    });
    const fb = await new FacebookProvider({ fetchImpl: fake.fetchImpl }).metrics(
      {
        publicationId: 'p',
        providerPostId: 'page_post',
        account: { ...base, provider: 'facebook', accountType: 'page' },
      },
      ctx,
    );
    expect(fb).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: 800, reach: 600, reactions: 20, comments: 5, shares: 9, clicks: 20 },
    });
    const ig = await new InstagramProvider({ fetchImpl: fake.fetchImpl }).metrics(
      {
        publicationId: 'p',
        providerPostId: 'media1',
        account: { ...base, provider: 'instagram', accountType: 'business' },
      },
      ctx,
    );
    expect(ig).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: 1500, reach: 1100, reactions: 90, saves: 11 },
    });
  });
});
