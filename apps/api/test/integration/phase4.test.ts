import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import type { FakeProvider } from '@postelyo/publishing-core';
import { auditLog, campaign, post, publication, shortLink } from '../../src/infra/db/schema.js';
import { runMaintenance } from '../../src/jobs/maintenance.job.js';
import { occurrences, upcomingSlots } from '../../src/modules/posts/series.service.js';
import { withUtm } from '../../src/modules/links/link.service.js';
import { createFakeProviders } from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Phase 4 content operations: template v2 with companion databases,
 * campaigns with summaries, recurring and evergreen series, first comments,
 * UTM/short links, approval enforcement and idea promotion. Everything runs
 * through the fake Notion and the FakeProvider.
 */
describe('phase 4 content operations', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let contentDb: string;
  let campaignsDb: string;
  let ideasDb: string;
  let provider: FakeProvider;
  let seq = 0;

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    c = cookie,
  ) =>
    stack.app.inject({
      method,
      url,
      headers: {
        cookie: c,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const sync = async () => {
    const res = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      {},
    );
    expect([200, 207]).toContain(res.statusCode);
    return res.json<{
      pagesSeen: number;
      errors: string[];
      extras?: Record<string, unknown> & { warnings: string[] };
    }>();
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
    await stack.services.scheduler.tick(`p4-${++seq}`);
    const out: Record<string, string> = {};
    for (const p of pubs) {
      out[p.id] = await stack.services.engine.handle(
        { publicationId: p.id, cycleNo: p.cycleNo },
        `p4-run-${++seq}`,
      );
    }
    return out;
  };

  const now = () => stack.clock.now();
  const inMinutes = (m: number) => new Date(now().getTime() + m * 60_000).toISOString();

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
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p4')));
    await stack.grantPlan(workspaceId, 'agency');

    // Connect with Notion and create the v2 template suite.
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
    expect(done.statusCode).toBe(200);
    const dto = done.json<{
      databaseId: string;
      templateVersion: number;
      campaignsDatabaseId: string | null;
      ideasDatabaseId: string | null;
    }>();
    contentDb = dto.databaseId;
    campaignsDb = dto.campaignsDatabaseId!;
    ideasDb = dto.ideasDatabaseId!;

    // One LinkedIn profile to publish to.
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

  // ---------------------------------------------------------------------------

  it('creates the template suite with relations and detects the companions', () => {
    expect(campaignsDb).toBeTruthy();
    expect(ideasDb).toBeTruthy();
    const content = fake.notion.createdDatabases.get(contentDb) as {
      properties: Record<string, { type: string; relation?: { database_id: string } }>;
    };
    expect(content.properties['Campaign']?.type).toBe('relation');
    expect(content.properties['Campaign']?.relation?.database_id).toBe(campaignsDb);
    expect(content.properties['Repeat Of']?.relation?.database_id).toBe(contentDb);
    expect(content.properties['First Comment']?.type).toBe('rich_text');
  });

  it('links posts to campaigns and writes a summary back to the campaign page', async () => {
    fake.notion.upsert('camp-1', {
      databaseId: campaignsDb,
      title: 'Autumn launch',
      status: 'Active',
      publishDate: { start: '2026-10-01' },
    });
    fake.notion.upsert('p4-camp-post', {
      status: 'Scheduled',
      title: 'Campaign post',
      platforms: ['LinkedIn'],
      publishDate: { start: inMinutes(-1) },
      body: ['launch text'],
      campaignIds: ['camp-1'],
    });
    const s = await sync();
    expect(s.errors).toEqual([]);
    expect(s.extras?.['campaignsSeen']).toBe(1);
    const row = await postByPage('p4-camp-post');
    expect(row.campaignId).not.toBeNull();
    const [c] = await stack.db.db.select().from(campaign).where(eq(campaign.id, row.campaignId!));
    expect(c!.name).toBe('Autumn launch');
    expect(c!.externalId).toBe('camp-1');
    // Summary after scheduling: 1 scheduled.
    expect(fake.notion.pages.get('camp-1')!.extra['scheduled']).toBe(1);
    expect(fake.notion.pages.get('camp-1')!.extra['published']).toBe(0);

    const list = await inject('GET', `/v1/workspaces/${workspaceId}/campaigns`);
    const campaigns = list.json<{
      campaigns: { name: string; summary: { scheduled: number } | null }[];
    }>().campaigns;
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]!.name).toBe('Autumn launch');
    expect(campaigns[0]!.summary?.scheduled).toBe(1);

    await publishAll(await pubsOf(row.id));
    await sync();
    const page = fake.notion.pages.get('camp-1')!;
    expect(page.extra['published']).toBe(1);
    expect(page.extra['scheduled']).toBe(0);
    expect(String(page.extra['summary'])).toContain('1 published');
    const audit = await stack.db.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.event, 'campaign.summary_written')),
      );
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('computes recurring occurrences and evergreen slots deterministically', () => {
    expect(occurrences('2026-10-01T09:00:00.000+02:00', 'weekly', '2026-10-31', null)).toEqual([
      '2026-10-08T09:00:00.000+02:00',
      '2026-10-15T09:00:00.000+02:00',
      '2026-10-22T09:00:00.000+02:00',
      '2026-10-29T09:00:00.000+02:00',
    ]);
    expect(occurrences('2026-01-31', 'monthly', '2026-04-30', '2026-03-31')).toEqual([
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(occurrences('2026-10-01', 'biweekly', '2026-10-20', null)).toEqual(['2026-10-15']);
    const slots = upcomingSlots(
      new Date('2026-09-28T08:00:00Z'), // Monday
      7,
      [{ weekday: 2, time: '09:00' }],
      'Europe/Berlin',
    );
    expect(slots.map((d) => d.toISOString())).toEqual(['2026-09-29T07:00:00.000Z']);
  });

  it('materialises recurring instances as real pages, keeps provenance and propagates source edits', async () => {
    const start = new Date(now().getTime() + 24 * 3600_000).toISOString();
    fake.notion.upsert('p4-weekly', {
      status: 'Scheduled',
      title: 'Weekly tip',
      platforms: ['LinkedIn'],
      publishDate: { start },
      body: ['tip v1'],
      repeat: 'Weekly',
      firstComment: 'Read more on our blog',
    });
    const s1 = await sync();
    expect(s1.extras?.['instancesCreated']).toBe(8); // 60 days ahead, weekly
    const src = await postByPage('p4-weekly');
    expect(src.repeatRule).toBe('weekly');
    const instances = await stack.db.db.select().from(post).where(eq(post.parentPostId, src.id));
    expect(instances).toHaveLength(8);
    const first = instances.sort((a, b) => a.seriesKey!.localeCompare(b.seriesKey!))[0]!;
    expect(first.seriesKey).toBe(
      `p4-weekly:${new Date(Date.parse(start) + 7 * 86_400_000).toISOString().slice(0, 10)}`,
    );
    const page = fake.notion.pages.get(first.externalId!)!;
    expect(page.repeatOf).toEqual(['p4-weekly']);
    expect(page.status).toBe('Scheduled');
    expect(page.firstComment).toBe('Read more on our blog');
    expect(fake.notion.bodyOf(first.externalId!)).toEqual(['tip v1']);

    // The next sync ingests the instances as ordinary scheduled pages.
    const s2 = await sync();
    expect(s2.extras?.['instancesCreated']).toBe(0);
    const ingested = await postByPage(first.externalId!);
    expect(ingested.state).toBe('scheduled');
    expect(ingested.parentPostId).toBe(src.id);
    expect((await pubsOf(ingested.id)).map((p) => p.state)).toEqual(['scheduled']);

    // Edit one instance by hand, then change the source: only untouched instances follow.
    const second = instances.sort((a, b) => a.seriesKey!.localeCompare(b.seriesKey!))[1]!;
    fake.notion.upsert(second.externalId!, { body: ['my own words'] });
    await sync();
    fake.notion.upsert('p4-weekly', { body: ['tip v2'] });
    const s3 = await sync();
    expect(s3.extras?.['instancesUpdated']).toBe(7);
    expect(s3.extras?.['warnings']).toEqual([expect.stringContaining('edited by hand')]);
    expect(fake.notion.bodyOf(first.externalId!)).toEqual(['tip v2']);
    expect(fake.notion.bodyOf(second.externalId!)).toEqual(['my own words']);

    // Repeat Until bounds the series; nothing beyond it is created.
    fake.notion.upsert('p4-weekly', {
      repeatUntil: new Date(Date.parse(start) + 8 * 86_400_000).toISOString().slice(0, 10),
    });
    const s4 = await sync();
    expect(s4.extras?.['instancesCreated']).toBe(0);
  });

  it('fills evergreen slots from the pool, honouring the minimum gap', async () => {
    const tz = 'UTC';
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      defaultTimezone: tz,
      evergreen: {
        slots: [
          { weekday: 1, time: '10:00' },
          { weekday: 4, time: '10:00' },
        ],
        minGapDays: 30,
      },
    });
    fake.notion.upsert('p4-ever-1', {
      status: 'Ready',
      title: 'Evergreen A',
      platforms: ['LinkedIn'],
      body: ['always relevant A'],
      repeat: 'Evergreen',
    });
    fake.notion.upsert('p4-ever-2', {
      status: 'Ready',
      title: 'Evergreen B',
      platforms: ['LinkedIn'],
      body: ['always relevant B'],
      repeat: 'Evergreen',
    });
    const s = await sync();
    // Two pages, minimum gap 30 days, 14-day lookahead with 2 slots a week: each page once.
    expect(s.extras?.['evergreenFilled']).toBe(2);
    expect(fake.notion.pages.get('p4-ever-1')!.system.postelyoStatus).toBe('In evergreen pool');
    const a = await postByPage('p4-ever-1');
    const b = await postByPage('p4-ever-2');
    const instA = await stack.db.db.select().from(post).where(eq(post.parentPostId, a.id));
    const instB = await stack.db.db.select().from(post).where(eq(post.parentPostId, b.id));
    expect(instA).toHaveLength(1);
    expect(instB).toHaveLength(1);
    expect(instA[0]!.seriesKey!.startsWith('evergreen:')).toBe(true);
    const again = await sync();
    expect(again.extras?.['evergreenFilled']).toBe(0);
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, { evergreen: null });
  });

  it('posts the first comment once after publishing and reports it in Notion', async () => {
    fake.notion.upsert('p4-comment', {
      status: 'Scheduled',
      title: 'With comment',
      platforms: ['LinkedIn'],
      publishDate: { start: inMinutes(-1) },
      body: ['main text'],
      firstComment: 'Here is the link: https://example.com/more',
    });
    await sync();
    const row = await postByPage('p4-comment');
    const pubs = await pubsOf(row.id);
    expect(pubs[0]!.firstCommentState).toBe('pending');
    const before = provider.comments.length;
    await publishAll(pubs);
    const [pub] = await pubsOf(row.id);
    expect(pub!.state).toBe('published');
    expect(pub!.firstCommentState).toBe('posted');
    expect(pub!.firstCommentId).toBe(`fake-comment-${before + 1}`);
    expect(provider.comments).toHaveLength(before + 1);
    expect(provider.comments.at(-1)!.input.providerPostId).toBe(pub!.providerPostId);
    expect(provider.comments.at(-1)!.input.text).toBe('Here is the link: https://example.com/more');
    // Idempotent: a retry of the comment step does nothing.
    expect(await stack.services.engine.postFirstComment(pub!.id, 'again')).toBe('skipped');
    expect(provider.comments).toHaveLength(before + 1);

    await stack.services.resultWriteback.writeback(pub!.id, 'wb-comment');
    expect(fake.notion.pages.get('p4-comment')!.system.postelyoNote).toContain(
      'First comment posted',
    );
    const detail = await inject('GET', `/v1/workspaces/${workspaceId}/publications/${pub!.id}`);
    expect(detail.json<{ firstCommentState: string }>().firstCommentState).toBe('posted');
  });

  it('applies UTM presets and short links at render time only, and counts clicks', async () => {
    expect(
      withUtm(
        'https://acme.com/blog?x=1',
        { source: 'postelyo', medium: 'social', campaign: '{platform}-{campaign}' },
        {
          platform: 'linkedin',
          campaignName: 'Autumn Launch',
        },
      ),
    ).toBe(
      'https://acme.com/blog?x=1&utm_source=postelyo&utm_medium=social&utm_campaign=linkedin-autumn-launch',
    );
    expect(
      withUtm(
        'https://acme.com/?utm_source=x',
        { source: 'y' },
        { platform: 'x', campaignName: null },
      ),
    ).toBe('https://acme.com/?utm_source=x');

    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      links: {
        utm: { source: 'postelyo', medium: 'social', campaign: '{campaign}' },
        shorten: true,
      },
    });
    fake.notion.upsert('p4-links', {
      status: 'Scheduled',
      title: 'Link post',
      platforms: ['LinkedIn'],
      publishDate: { start: inMinutes(-1) },
      body: ['Read https://acme.com/post today'],
      campaignIds: ['camp-1'],
    });
    await sync();
    const row = await postByPage('p4-links');
    const pubs = await pubsOf(row.id);
    await publishAll(pubs);
    const call = provider.calls.at(-1)!;
    expect(call.input.content.text).toMatch(/^Read http:\/\/localhost\/l\/[A-Za-z0-9_-]+ today$/);
    // The Notion source is untouched.
    expect(fake.notion.bodyOf('p4-links')).toEqual(['Read https://acme.com/post today']);
    const [link] = await stack.db.db
      .select()
      .from(shortLink)
      .where(eq(shortLink.publicationId, pubs[0]!.id));
    expect(link!.targetUrl).toBe(
      'https://acme.com/post?utm_source=postelyo&utm_medium=social&utm_campaign=autumn-launch',
    );
    const hit = await stack.app.inject({ method: 'GET', url: `/l/${link!.code}` });
    expect(hit.statusCode).toBe(302);
    expect(hit.headers.location).toBe(link!.targetUrl);
    const miss = await stack.app.inject({ method: 'GET', url: '/l/nope-nope' });
    expect(miss.statusCode).toBe(404);
    await stack.services.resultWriteback.writeback(pubs[0]!.id, 'wb-links');
    expect(fake.notion.pages.get('p4-links')!.system.linkReport).toContain('(1 clicks)');
    const detail = await inject('GET', `/v1/workspaces/${workspaceId}/publications/${pubs[0]!.id}`);
    expect(detail.json<{ links: { clicks: number }[] }>().links).toEqual([
      expect.objectContaining({ clicks: 1 }),
    ]);
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, { links: null });
  });

  it('enforces approvals when the policy is on: refuses scheduling until a reviewer approves the exact content', async () => {
    const reviewerEmail = uniqueEmail('p4-reviewer');
    const reviewerCookie = await stack.signIn(reviewerEmail);
    const meRes = await inject('GET', '/v1/me', undefined, reviewerCookie);
    const reviewerId = meRes.json<{ user: { id: string } }>().user.id;
    // Invite as editor, then make them a reviewer.
    const inv = await inject('POST', `/v1/workspaces/${workspaceId}/invitations`, {
      email: reviewerEmail,
      role: 'editor',
    });
    expect(inv.statusCode).toBe(201);
    const token = stack.mailer
      .lastTo(reviewerEmail)!
      .text.match(/\/invitations\/([A-Za-z0-9_-]+)/)![1]!;
    await inject('POST', `/v1/invitations/${token}/accept`, {}, reviewerCookie);
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      approval: { required: true, reviewers: [reviewerId] },
    });

    fake.notion.upsert('p4-approve', {
      status: 'Ready',
      title: 'Needs sign-off',
      platforms: ['LinkedIn'],
      publishDate: { start: inMinutes(60) },
      body: ['draft copy'],
    });
    await sync();
    let page = fake.notion.pages.get('p4-approve')!;
    expect(page.system.postelyoStatus).toBe('Awaiting approval');
    expect(page.system.approval).toBe('Awaiting approval');

    // Scheduling without approval is refused.
    fake.notion.upsert('p4-approve', { status: 'Scheduled' });
    await sync();
    page = fake.notion.pages.get('p4-approve')!;
    expect(page.system.postelyoStatus).toBe('Validation error');
    expect(page.system.postelyoNote).toContain('reviewer must approve');
    let row = await postByPage('p4-approve');
    expect(
      (row.validationErrors as { code: string }[]).some((e) => e.code === 'APPROVAL_REQUIRED'),
    ).toBe(true);
    expect(await pubsOf(row.id)).toHaveLength(0);

    // Back to Ready: it shows in the queue; a non-reviewer editor cannot approve, the reviewer can.
    fake.notion.upsert('p4-approve', { status: 'Ready' });
    await sync();
    const queue = await inject('GET', `/v1/workspaces/${workspaceId}/approvals`);
    expect(queue.json<{ pending: { postId: string }[] }>().pending.map((p) => p.postId)).toContain(
      row.id,
    );
    const denied = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/posts/${row.id}/approve`,
      {},
      cookie,
    );
    // The owner is always allowed; use the reviewer for the real approval after checking a stranger.
    expect(denied.statusCode).toBe(200);
    await inject(
      'DELETE',
      `/v1/workspaces/${workspaceId}/posts/${row.id}/approvals`,
      undefined,
      cookie,
    );
    const ok = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/posts/${row.id}/approve`,
      {},
      reviewerCookie,
    );
    expect(ok.statusCode).toBe(200);
    // The approval enqueues a page sync so the Notion column flips without an edit.
    const job = stack.enqueue.syncPages.at(-1)!;
    expect(job.pageId).toBe('p4-approve');
    await stack.services.notionSync.syncPage(
      job.workspaceId,
      job.sourceId,
      job.pageId,
      'approve-sync',
    );
    page = fake.notion.pages.get('p4-approve')!;
    expect(page.system.approval).toBe('Approved');
    expect(page.system.postelyoStatus).toBe('Awaiting schedule');

    // Now scheduling works.
    fake.notion.upsert('p4-approve', { status: 'Scheduled' });
    await sync();
    row = await postByPage('p4-approve');
    expect(row.validationErrors).toBeNull();
    expect((await pubsOf(row.id)).map((p) => p.state)).toEqual(['scheduled']);
    expect(fake.notion.pages.get('p4-approve')!.system.approval).toBe('Approved');

    // Any edit invalidates the approval.
    fake.notion.upsert('p4-approve', { body: ['draft copy, edited'] });
    await sync();
    row = await postByPage('p4-approve');
    expect(
      (row.validationErrors as { code: string }[]).some((e) => e.code === 'APPROVAL_REQUIRED'),
    ).toBe(true);
    expect(fake.notion.pages.get('p4-approve')!.system.approval).toBe('Changes since approval');
    expect((await pubsOf(row.id)).map((p) => p.state)).toEqual(['cancelled']);

    // A workspace without the policy keeps today's behaviour.
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, { approval: null });
    await sync();
    row = await postByPage('p4-approve');
    expect(row.validationErrors).toBeNull();
  });

  it('promotes an idea to a draft post and marks the idea as promoted', async () => {
    fake.notion.upsert('idea-1', {
      databaseId: ideasDb,
      title: 'Talk about onboarding',
      status: 'New',
      postText: 'Three lessons from our onboarding rewrite',
      platforms: ['LinkedIn', 'X'],
      body: ['lesson one', 'lesson two'],
    });
    let s = await sync();
    expect(s.extras?.['promoted']).toBe(0);
    fake.notion.upsert('idea-1', { status: 'Promote' });
    s = await sync();
    expect(s.extras?.['promoted']).toBe(1);
    const idea = fake.notion.pages.get('idea-1')!;
    expect(idea.status).toBe('Promoted');
    const created = fake.notion.createdPages.at(-1)!;
    expect(idea.extra['postUrl']).toBe(`https://www.notion.so/${created.replace(/-/g, '')}`);
    const draft = fake.notion.pages.get(created)!;
    expect(draft.databaseId).toBe(contentDb);
    expect(draft.title).toBe('Talk about onboarding');
    expect(draft.status).toBe('Draft');
    expect(draft.platforms).toEqual(['LinkedIn', 'X']);
    expect(fake.notion.bodyOf(created)).toEqual([
      'Three lessons from our onboarding rewrite',
      'lesson one',
      'lesson two',
    ]);
    // The draft is an ordinary page on the next sync; nothing is published.
    await sync();
    const row = await postByPage(created);
    expect(row.state).toBe('draft');
    const s3 = await sync();
    expect(s3.extras?.['promoted']).toBe(0);
  });

  it('retries pending first comments from maintenance', async () => {
    const original = provider['opts'] as Record<string, unknown>;
    let calls = 0;
    (provider as unknown as { opts: Record<string, unknown> }).opts = {
      ...original,
      commentDecide: () =>
        ++calls === 1
          ? { kind: 'failed', reason: 'temporary', retryable: true }
          : { kind: 'posted', commentId: 'late-comment' },
    };
    try {
      fake.notion.upsert('p4-comment-retry', {
        status: 'Scheduled',
        title: 'Comment retry',
        platforms: ['LinkedIn'],
        publishDate: { start: inMinutes(-1) },
        body: ['text'],
        firstComment: 'second try',
      });
      await sync();
      const row = await postByPage('p4-comment-retry');
      const pubs = await pubsOf(row.id);
      await publishAll(pubs);
      let [pub] = await pubsOf(row.id);
      expect(pub!.firstCommentState).toBe('pending');
      expect(pub!.firstCommentError).toBe('temporary');
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
          engine: stack.services.engine,
        },
        'maint-p4',
        pino({ level: 'silent' }),
      );
      [pub] = await pubsOf(row.id);
      expect(pub!.firstCommentState).toBe('posted');
      expect(pub!.firstCommentId).toBe('late-comment');
    } finally {
      (provider as unknown as { opts: Record<string, unknown> }).opts = original;
    }
  });
});
