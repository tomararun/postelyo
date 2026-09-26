import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  mediaAsset,
  post,
  publication,
  socialAccount,
} from '../../src/infra/db/schema.js';
import {
  FILES_HOST,
  NOTION_GOOD_DB,
  NOTION_VALID_TOKEN,
  createFakeProviders,
} from './fake-providers.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

const FUTURE = '2027-03-10T09:00:00.000+01:00'; // absolute instant, 08:00Z
const FUTURE_2 = '2027-03-11T10:30:00.000+01:00';

describe('content pipeline (Notion sync → posts/publications → writeback)', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let accountId: string;

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
    return res.json<{
      pagesSeen: number;
      actions: Record<string, number>;
      writebacks: number;
      errors: string[];
    }>();
  };

  const postsFor = async (externalId: string) => {
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, externalId));
    const pubs = p
      ? await stack.db.db.select().from(publication).where(eq(publication.postId, p.id))
      : [];
    return { post: p, pubs };
  };

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
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('pipe')));
    await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { defaultTimezone: 'Europe/Berlin', defaultPublishTime: '09:00' },
    });
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = connect.json<{ id: string }>().id;
    accountId = await connectLinkedIn();
  });
  afterAll(async () => {
    await stack.close();
  });

  it('mirrors editorial statuses without enforcement and never enqueues Ready', async () => {
    fake.notion.upsert('p-draft', { status: 'Draft', title: 'A draft' });
    fake.notion.upsert('p-ready', {
      status: 'Ready',
      publishDate: { start: FUTURE },
      title: 'Ready one',
    });
    fake.notion.upsert('p-ready-nodate', {
      status: 'Ready',
      publishDate: null,
      title: 'Ready no date',
    });
    fake.notion.upsert('p-review', { status: 'In review', title: 'Reviewing' });

    const s = await sync();
    expect(s.errors).toEqual([]);
    expect(s.pagesSeen).toBe(4);

    expect((await postsFor('p-draft')).post).toMatchObject({
      state: 'draft',
      sourceStatus: 'Draft',
    });
    expect((await postsFor('p-review')).post).toMatchObject({ state: 'in_review' });

    const ready = await postsFor('p-ready');
    expect(ready.post?.state).toBe('ready');
    expect(ready.pubs).toHaveLength(0);
    expect(fake.notion.pages.get('p-ready')?.system.postelyoStatus).toBe('Awaiting schedule');
    expect(fake.notion.pages.get('p-ready-nodate')?.system.postelyoStatus).toBeNull();
    expect(fake.notion.pages.get('p-draft')?.system.postelyoStatus).toBeNull();

    const observed = await stack.db.db
      .select({ to: auditLog.toState })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, 'post.source_status_observed'),
          eq(auditLog.entityId, ready.post!.id),
        ),
      );
    expect(observed.map((o) => o.to)).toEqual(['Ready']);
  });

  it('schedules a valid page: snapshot from body, publication row, writeback with id', async () => {
    fake.notion.upsert('p-sched', {
      status: 'Scheduled',
      title: 'Launch',
      publishDate: { start: FUTURE },
      body: ['Hello from the body', 'Second paragraph'],
      postText: 'ignored fallback',
      media: [{ name: 'hero.png', url: `${FILES_HOST}/hero.png` }],
    });
    const s = await sync();
    expect(s.actions['scheduled']).toBe(1);

    const { post: p, pubs } = await postsFor('p-sched');
    expect(p?.state).toBe('scheduled');
    expect(p?.validationErrors).toBeNull();
    expect(p?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const content = p?.content as {
      blocks: { inlines: { text: string }[] }[];
      media: { assetId: string }[];
    };
    expect(content.blocks.map((b) => b.inlines[0]!.text)).toEqual([
      'Hello from the body',
      'Second paragraph',
    ]);
    expect(content.media).toHaveLength(1);
    const assets = await stack.db.db.select().from(mediaAsset).where(eq(mediaAsset.postId, p!.id));
    expect(assets).toHaveLength(1);
    expect(assets[0]?.id).toBe(content.media[0]!.assetId);
    expect(assets[0]?.mimeType).toBe('image/png');

    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({
      state: 'scheduled',
      provider: 'linkedin',
      socialAccountId: accountId,
      scheduledTz: 'Europe/Berlin',
      scheduledLocal: '2027-03-10T09:00',
      cycleNo: 0,
    });
    expect(pubs[0]!.scheduledAt.toISOString()).toBe('2027-03-10T08:00:00.000Z');

    const page = fake.notion.pages.get('p-sched')!;
    expect(page.system.postelyoStatus).toBe('Scheduled');
    expect(page.system.postelyoId).toBe(pubs[0]!.id);
    expect(page.system.postelyoNote).toContain('Scheduled for 2027-03-10T09:00 (Europe/Berlin)');

    const events = await stack.db.db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.entityId, pubs[0]!.id)));
    expect(events.map((e) => e.event)).toEqual(['publication.created']);
  });

  it('is idempotent: a second sync with no user edits patches nothing new', async () => {
    const before = fake.notion.patches.length;
    // Our own writeback bumped last_edited_time, so the page is re-read once more.
    await sync();
    await sync();
    expect(fake.notion.patches.length).toBe(before);
    const { pubs } = await postsFor('p-sched');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.state).toBe('scheduled');
  });

  it('reports validation errors instead of scheduling', async () => {
    fake.notion.upsert('p-noplat', {
      status: 'Scheduled',
      publishDate: { start: FUTURE },
      platforms: [],
      body: ['x'],
    });
    fake.notion.upsert('p-past', {
      status: 'Scheduled',
      publishDate: { start: '2020-01-01T09:00:00.000+01:00' },
      body: ['x'],
    });
    fake.notion.upsert('p-nodate', { status: 'Scheduled', publishDate: null, body: ['x'] });
    fake.notion.upsert('p-empty', {
      status: 'Scheduled',
      publishDate: { start: FUTURE },
      body: [],
      postText: '',
    });
    fake.notion.upsert('p-long', {
      status: 'Scheduled',
      publishDate: { start: FUTURE },
      body: ['y'.repeat(3001)],
    });
    const s = await sync();
    expect(s.actions['validation_error']).toBe(5);

    const expectError = async (id: string, code: string) => {
      const { post: p, pubs } = await postsFor(id);
      expect(p?.state).toBe('scheduled');
      expect((p?.validationErrors as { code: string }[]).map((e) => e.code)).toContain(code);
      expect(pubs).toHaveLength(0);
      expect(fake.notion.pages.get(id)?.system.postelyoStatus).toBe('Validation error');
      expect(fake.notion.pages.get(id)?.system.postelyoNote.length).toBeGreaterThan(5);
    };
    await expectError('p-noplat', 'PLATFORMS_MISSING');
    await expectError('p-past', 'DATE_IN_PAST');
    await expectError('p-nodate', 'DATE_MISSING');
    await expectError('p-empty', 'TEXT_EMPTY');
    await expectError('p-long', 'TEXT_TOO_LONG');
  });

  it('reschedules when the date changes and cancels when the status leaves Scheduled', async () => {
    fake.notion.upsert('p-sched', { publishDate: { start: FUTURE_2 } });
    await sync();
    let { pubs } = await postsFor('p-sched');
    expect(pubs[0]?.state).toBe('scheduled');
    expect(pubs[0]?.scheduledAt.toISOString()).toBe('2027-03-11T09:30:00.000Z');
    expect(pubs[0]?.scheduledLocal).toBe('2027-03-11T10:30');
    const resched = await stack.db.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.event, 'publication.rescheduled'), eq(auditLog.entityId, pubs[0]!.id)),
      );
    expect(resched).toHaveLength(1);

    fake.notion.upsert('p-sched', { status: 'Changes requested' });
    await sync();
    ({ pubs } = await postsFor('p-sched'));
    expect(pubs[0]?.state).toBe('cancelled');
    expect((await postsFor('p-sched')).post?.state).toBe('changes_requested');
    const page = fake.notion.pages.get('p-sched')!;
    expect(page.system.postelyoStatus).toBeNull();
    expect(page.system.postelyoId).toBe('');
  });

  it('re-scheduling after cancellation or failure starts a new cycle on the same row', async () => {
    fake.notion.upsert('p-sched', { status: 'Scheduled' });
    await sync();
    let { post: p, pubs } = await postsFor('p-sched');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.state).toBe('scheduled');
    expect(pubs[0]?.cycleNo).toBe(1);
    expect(p?.cycleNo).toBe(1);

    // Simulate a terminal failure from the engine, then the user retries by setting Scheduled again.
    await stack.db.db
      .update(publication)
      .set({ state: 'failed', attemptNo: 5, lastErrorCode: 'content', failedAt: new Date() })
      .where(eq(publication.id, pubs[0]!.id));
    fake.notion.upsert('p-sched', { status: 'Draft' });
    await sync();
    fake.notion.upsert('p-sched', { status: 'Scheduled' });
    await sync();
    ({ post: p, pubs } = await postsFor('p-sched'));
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({
      state: 'scheduled',
      cycleNo: 2,
      attemptNo: 0,
      lastErrorCode: null,
    });
    expect(p?.cycleNo).toBe(2);
  });

  it('leaves in-flight publications alone and freezes the snapshot close to publish time', async () => {
    const { pubs } = await postsFor('p-sched');
    await stack.db.db
      .update(publication)
      .set({ state: 'queued', queuedAt: new Date() })
      .where(eq(publication.id, pubs[0]!.id));
    fake.notion.upsert('p-sched', { body: ['Edited while queued'] });
    const before = (await postsFor('p-sched')).post!.contentHash;
    await sync();
    const after = await postsFor('p-sched');
    expect(after.pubs[0]?.state).toBe('queued');
    expect(after.post?.contentHash).toBe(before);
    expect((after.post?.warnings as string[]).join(' ')).toContain('in progress');
    expect(after.post?.state).toBe('publishing');
    // Restore for later tests.
    await stack.db.db
      .update(publication)
      .set({ state: 'scheduled', queuedAt: null })
      .where(eq(publication.id, pubs[0]!.id));
  });

  it('blocks publications when the account needs re-authorization, and unblocks after reconnect', async () => {
    await stack.db.db
      .update(socialAccount)
      .set({ status: 'needs_reauth' })
      .where(eq(socialAccount.id, accountId));
    fake.notion.upsert('p-blocked', {
      status: 'Scheduled',
      publishDate: { start: FUTURE },
      body: ['blocked'],
    });
    await sync();
    let { pubs } = await postsFor('p-blocked');
    expect(pubs[0]?.state).toBe('blocked');
    expect(fake.notion.pages.get('p-blocked')?.system.postelyoStatus).toBe(
      'Needs re-authorization',
    );

    await stack.db.db
      .update(socialAccount)
      .set({ status: 'active' })
      .where(eq(socialAccount.id, accountId));
    fake.notion.upsert('p-blocked', { title: 'touch' });
    await sync();
    ({ pubs } = await postsFor('p-blocked'));
    expect(pubs[0]?.state).toBe('scheduled');
    expect(fake.notion.pages.get('p-blocked')?.system.postelyoStatus).toBe('Scheduled');
  });

  it('cancels publications for archived or deleted pages', async () => {
    fake.notion.upsert('p-gone', {
      status: 'Scheduled',
      publishDate: { start: FUTURE },
      body: ['bye'],
    });
    await sync();
    expect((await postsFor('p-gone')).pubs[0]?.state).toBe('scheduled');

    fake.notion.delete('p-gone');
    await sync();
    const gone = await postsFor('p-gone');
    expect(gone.post?.deletedAt).toBeInstanceOf(Date);
    expect(gone.post?.state).toBe('cancelled');
    expect(gone.pubs[0]?.state).toBe('cancelled');
  });

  it('fails a page with no connected account for its platform', async () => {
    const other = await stack.signInWithWorkspace(uniqueEmail('noacc'));
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${other.workspaceId}/content-sources/notion`,
      headers: { cookie: other.cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    expect(connect.statusCode).toBe(201);
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${other.workspaceId}/content-sources/${connect.json<{ id: string }>().id}/sync`,
      headers: { cookie: other.cookie },
    });
    expect(res.statusCode).toBe(200);
    // Same fake database, separate workspace: posts are created per workspace and fail validation.
    const rows = await stack.db.db
      .select()
      .from(post)
      .where(eq(post.workspaceId, other.workspaceId));
    const scheduledWithPlatform = rows.filter(
      (r) => r.sourceStatus === 'Scheduled' && r.requestedPlatforms.length > 0,
    );
    expect(scheduledWithPlatform.length).toBeGreaterThan(0);
    for (const r of scheduledWithPlatform) {
      expect((r.validationErrors as { code: string }[]).map((e) => e.code)).toContain('NO_ACCOUNT');
    }
    const pubs = await stack.db.db
      .select()
      .from(publication)
      .where(eq(publication.workspaceId, other.workspaceId));
    expect(pubs).toHaveLength(0);
  });

  it('exposes posts and publications through the api and denies other tenants', async () => {
    const res = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/posts`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ posts: { externalId: string; publications: unknown[] }[] }>();
    expect(body.posts.find((p) => p.externalId === 'p-sched')?.publications).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(NOTION_VALID_TOKEN);

    const stranger = await stack.signInWithWorkspace(uniqueEmail('strange'));
    const denied = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/posts`,
      headers: { cookie: stranger.cookie },
    });
    expect(denied.statusCode).toBe(404);
  });
});
