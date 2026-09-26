import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pino } from 'pino';
import { FakeProvider, createProviderRegistry, textFingerprint } from '@postelyo/publishing-core';
import {
  auditLog,
  mediaAsset,
  mediaObject,
  post,
  publication,
  socialAccount,
} from '../../src/infra/db/schema.js';
import { TINY_PNG_1x1 } from '../../src/modules/media/test-images.js';
import { PublishEngine } from '../../src/modules/publishing/engine.js';
import { open } from '../../src/infra/crypto/envelope.js';
import {
  FILES_HOST,
  NOTION_GOOD_DB,
  NOTION_VALID_TOKEN,
  createFakeProviders,
} from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Phase 2: multi-platform core. Provider flags, X and Meta connect flows,
 * per-platform text, one publication per target, the media pipeline with
 * URL delivery, post-level writeback and X token refresh.
 */
describe('phase 2 multi-platform', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let provider: FakeProvider;
  let seq = 0;

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
  };

  const accounts = async () => {
    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    return list.json<{
      configured: Record<string, boolean>;
      accounts: {
        id: string;
        provider: string;
        accountType: string;
        displayName: string;
        parentAccountId: string | null;
        disconnectedAt: string | null;
      }[];
    }>();
  };

  const connect = async (path: string, callback: string, code: string) => {
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${path}/connect`,
      headers: { cookie },
    });
    if (start.statusCode !== 302) return { status: start.statusCode, location: '', authUrl: null };
    const authUrl = new URL(start.headers.location as string);
    const state = authUrl.searchParams.get('state')!;
    const cb = await stack.app.inject({
      method: 'GET',
      url: `/oauth/${callback}/callback?code=${code}&state=${state}`,
      headers: { cookie },
    });
    return { status: cb.statusCode, location: locationOf(cb), authUrl };
  };

  const duePage = async (input: {
    platforms: string[];
    body?: string;
    media?: { name: string; url: string }[];
    platformText?: Record<string, string>;
  }) => {
    const id = `p2-page-${++seq}`;
    fake.notion.upsert(id, {
      status: 'Scheduled',
      title: id,
      platforms: input.platforms,
      publishDate: { start: new Date(stack.clock.now().getTime() - 60_000).toISOString() },
      body: [input.body ?? `body of ${id}`],
      ...(input.media ? { media: input.media } : {}),
      ...(input.platformText ? { platformText: input.platformText } : {}),
    });
    await sync();
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, id));
    const pubs = p
      ? await stack.db.db.select().from(publication).where(eq(publication.postId, p.id))
      : [];
    return { pageId: id, post: p!, pubs };
  };

  const publishAll = async (pubs: { id: string; cycleNo: number }[]) => {
    await stack.services.scheduler.tick(`p2-${++seq}`);
    const out: Record<string, string> = {};
    for (const p of pubs) {
      out[p.id] = await stack.services.engine.handle(
        { publicationId: p.id, cycleNo: p.cycleNo },
        `p2-pub-${p.id}`,
      );
    }
    return out;
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        X_CLIENT_ID: 'x-client',
        X_CLIENT_SECRET: 'x-secret',
        META_APP_ID: 'meta-app',
        META_APP_SECRET: 'meta-secret',
      },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p2')));
    const src = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = src.json<{ id: string }>().id;
    await connect('linkedin', 'linkedin', 'good-code');
    provider = stack.services.providers.get('linkedin') as FakeProvider;
  });
  afterAll(async () => {
    await stack.db.db
      .update(publication)
      .set({ state: 'cancelled' })
      .where(and(eq(publication.workspaceId, workspaceId), eq(publication.state, 'scheduled')));
    await stack.close();
  });

  // ---------------------------------------------------------------------------
  // Provider flags and connect flows
  // ---------------------------------------------------------------------------

  it('keeps new providers off until the workspace enables them', async () => {
    const before = await accounts();
    expect(before.configured).toEqual({
      linkedin: true,
      x: false,
      facebook: false,
      instagram: false,
    });
    const denied = await connect('x', 'x', 'x-good');
    expect(denied.status).toBe(403);

    const page = await duePage({ platforms: ['X'] });
    expect(page.pubs).toHaveLength(0);
    expect((page.post.validationErrors as { code: string }[]).map((e) => e.code)).toContain(
      'PLATFORM_DISABLED',
    );

    const enable = await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: { providers: { x: true, facebook: true, instagram: true } },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({
      providers: { linkedin: true, x: true, facebook: true, instagram: true },
    });
    expect((await accounts()).configured).toEqual({
      linkedin: true,
      x: true,
      facebook: true,
      instagram: true,
    });
    fake.notion.upsert(page.pageId, { status: 'Cancelled' });
    await sync();
  });

  it('connects an X profile with PKCE and stores tokens sealed', async () => {
    const r = await connect('x', 'x', 'x-good');
    expect(r.location).toBe(`/w/${workspaceId}/connections?connected=x`);
    expect(r.authUrl!.origin + r.authUrl!.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(r.authUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.authUrl!.searchParams.get('scope')).toContain('offline.access');
    const exchange = fake.requests.find((q) => q.url === 'https://api.x.com/2/oauth2/token');
    expect(new URLSearchParams(exchange!.body).get('code_verifier')).toBeTruthy();
    expect(exchange!.headers['authorization']).toMatch(/^Basic /);

    const x = (await accounts()).accounts.find((a) => a.provider === 'x')!;
    expect(x).toMatchObject({ accountType: 'member', displayName: '@alice' });
    const [row] = await stack.db.db.select().from(socialAccount).where(eq(socialAccount.id, x.id));
    expect(
      open(stack.keyProvider, row!.accessTokenEnc!, `social_account.access_token:${row!.id}`),
    ).toBe('XAT-1');
    expect(
      open(stack.keyProvider, row!.refreshTokenEnc!, `social_account.refresh_token:${row!.id}`),
    ).toBe('XRT-1');
    expect(row!.tokenExpiresAt!.getTime() - Date.now()).toBeLessThan(2 * 3_600_000 + 5_000);
  });

  it('connects Facebook Pages and their Instagram accounts, and disconnects children with the parent', async () => {
    const r = await connect('meta', 'meta', 'meta-good');
    expect(r.location).toBe(`/w/${workspaceId}/connections?connected=meta`);
    expect(r.authUrl!.searchParams.get('scope')).toContain('instagram_content_publish');
    const list = (await accounts()).accounts;
    const pages = list.filter((a) => a.provider === 'facebook');
    const igs = list.filter((a) => a.provider === 'instagram');
    expect(pages.map((p) => p.displayName).sort()).toEqual(['Acme Page', 'Other Page']);
    expect(igs.map((i) => i.displayName)).toEqual(['@acme']);
    const acme = pages.find((p) => p.displayName === 'Acme Page')!;
    expect(igs[0]!.parentAccountId).toBe(acme.id);
    const [igRow] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, igs[0]!.id));
    expect(
      open(stack.keyProvider, igRow!.accessTokenEnc!, `social_account.access_token:${igRow!.id}`),
    ).toBe('PAGE-TOKEN-1');
    expect(igRow!.tokenExpiresAt).toBeNull();

    const page = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/connections`,
      headers: { cookie },
    });
    expect(page.body).toContain('Acme Page');
    expect(page.body).toContain('@acme');
    expect(page.body).toContain('@alice');

    // Disconnect the other page: no child; disconnecting Acme takes @acme with it.
    const other = pages.find((p) => p.displayName === 'Other Page')!;
    await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${other.id}`,
      headers: { cookie },
    });
    await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${acme.id}`,
      headers: { cookie },
    });
    const after = (await accounts()).accounts.filter((a) => !a.disconnectedAt);
    expect(after.some((a) => a.provider === 'instagram')).toBe(false);
    expect(after.some((a) => a.provider === 'facebook')).toBe(false);
    // Reconnect for the remaining tests.
    await connect('meta', 'meta', 'meta-good');
    const again = (await accounts()).accounts.filter((a) => !a.disconnectedAt);
    expect(again.filter((a) => a.provider === 'instagram')).toHaveLength(1);
    await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${again.find((a) => a.displayName === 'Other Page')!.id}`,
      headers: { cookie },
    });
  });

  // ---------------------------------------------------------------------------
  // One page, four targets
  // ---------------------------------------------------------------------------

  it('creates one publication per target, honours per-platform text, and aggregates the writeback', async () => {
    const {
      pageId,
      post: p,
      pubs,
    } = await duePage({
      platforms: ['LinkedIn', 'X', 'Facebook Page', 'Instagram'],
      body: 'Shared body for everyone',
      media: [{ name: 'hero.jpg', url: `${FILES_HOST}/hero.jpg` }],
      platformText: { 'X Text': 'Short tweet version' },
    });
    expect(p.validationErrors).toBeNull();
    expect(pubs.map((x) => x.provider).sort()).toEqual(['facebook', 'instagram', 'linkedin', 'x']);
    expect((p.content as { platformText?: Record<string, string> }).platformText).toEqual({
      x: 'Short tweet version',
    });

    // X fails (content error), the rest publish.
    const xPub = pubs.find((x) => x.provider === 'x')!;
    provider.scriptOutcomes(); // none: first calls succeed
    const order = pubs.filter((x) => x.id !== xPub.id);
    const results = await publishAll(order);
    expect(Object.values(results).every((r) => r === 'published')).toBe(true);
    provider.scriptOutcomes({ kind: 'terminal_error', code: 'content', reason: 'too long for X' });
    expect(
      await stack.services.engine.handle(
        { publicationId: xPub.id, cycleNo: xPub.cycleNo },
        'x-fail',
      ),
    ).toBe('failed');
    const xCall = provider.calls.find((c) => c.input.account.provider === 'x')!;
    expect(xCall.input.content.text).toBe('Short tweet version');
    const liCall = provider.calls.find(
      (c) =>
        c.input.account.provider === 'linkedin' &&
        c.input.publicationId === pubs.find((x) => x.provider === 'linkedin')!.id,
    )!;
    expect(liCall.input.content.text).toBe('Shared body for everyone');

    const [after] = await stack.db.db.select().from(post).where(eq(post.id, p.id));
    expect(after?.state).toBe('partially_failed');

    // Aggregated writeback: partial status, one line per target, per-platform URLs.
    for (const pub of pubs) await stack.services.resultWriteback.writeback(pub.id, `wb-${pub.id}`);
    const page = fake.notion.pages.get(pageId)!;
    expect(page.system.postelyoStatus).toBe('Partially failed');
    expect(page.system.postelyoNote).toContain('X (@alice): failed: too long for X');
    expect(page.system.postelyoNote).toContain('LinkedIn (Alice Example): published');
    expect(page.system.postelyoNote).toContain('Instagram (@acme): published');
    expect(page.system.publishedUrl).toMatch(/^https:\/\/fake\.postelyo\.local\/posts\//);
    expect(page.system.publishedUrls.split('\n')).toHaveLength(3);
    expect(page.system.publishedUrls).toContain('Facebook (Acme Page): https://');
    expect(page.system.postelyoId.split(',').sort()).toEqual(pubs.map((x) => x.id).sort());

    // Retry X from Notion: only that publication gets a new cycle; the note ends up all published.
    fake.notion.upsert(pageId, { status: 'Draft' });
    await sync();
    fake.notion.upsert(pageId, { status: 'Scheduled' });
    await sync();
    const rows = await stack.db.db.select().from(publication).where(eq(publication.postId, p.id));
    expect(rows.find((r) => r.provider === 'x')?.state).toBe('scheduled');
    expect(rows.filter((r) => r.state === 'published')).toHaveLength(3);
    const retried = rows.find((r) => r.provider === 'x')!;
    expect(await publishAll([retried])).toEqual({ [retried.id]: 'published' });
    await stack.services.resultWriteback.writeback(retried.id, 'wb-x2');
    expect(fake.notion.pages.get(pageId)!.system.postelyoStatus).toBe('Published');
    expect(fake.notion.pages.get(pageId)!.system.publishedUrls.split('\n')).toHaveLength(4);
  });

  it('refreshes an expiring X token before publishing and audits it', async () => {
    const x = (await accounts()).accounts.find((a) => a.provider === 'x' && !a.disconnectedAt)!;
    await stack.db.db
      .update(socialAccount)
      .set({ tokenExpiresAt: new Date(stack.clock.now().getTime() + 60_000) })
      .where(eq(socialAccount.id, x.id));
    const { pubs } = await duePage({ platforms: ['X'], body: 'refresh me' });
    const before = fake.xRefreshes.length;
    expect(await publishAll(pubs)).toEqual({ [pubs[0]!.id]: 'published' });
    expect(fake.xRefreshes.length).toBe(before + 1);
    expect(fake.xRefreshes.at(-1)).toBe('XRT-1');
    const [row] = await stack.db.db.select().from(socialAccount).where(eq(socialAccount.id, x.id));
    expect(
      open(stack.keyProvider, row!.accessTokenEnc!, `social_account.access_token:${x.id}`),
    ).toMatch(/^XAT-refreshed-/);
    expect(row!.tokenExpiresAt!.getTime() - stack.clock.now().getTime()).toBeGreaterThan(3_600_000);
    const audits = await stack.db.db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, x.id), eq(auditLog.event, 'social_account.token_refreshed')),
      );
    expect(audits).toHaveLength(1);
    // Fresh token: no second refresh.
    const again = await duePage({ platforms: ['X'], body: 'no refresh' });
    await publishAll(again.pubs);
    expect(fake.xRefreshes.length).toBe(before + 1);
  });

  // ---------------------------------------------------------------------------
  // Media pipeline: storage, variants, public URLs
  // ---------------------------------------------------------------------------

  it('stores inspected images once per content hash and serves them from /media', async () => {
    const a = await duePage({
      platforms: ['LinkedIn'],
      media: [{ name: 'one.png', url: `${FILES_HOST}/one.png` }],
    });
    const b = await duePage({
      platforms: ['LinkedIn'],
      media: [{ name: 'two.png', url: `${FILES_HOST}/two.png` }],
    });
    const assets = await stack.db.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.workspaceId, workspaceId));
    const aAsset = assets.find((x) => x.postId === a.post.id)!;
    const bAsset = assets.find((x) => x.postId === b.post.id)!;
    expect(aAsset.mediaObjectId).toBeTruthy();
    // Same bytes (the fake serves the same PNG) → same object.
    expect(bAsset.mediaObjectId).toBe(aAsset.mediaObjectId);
    const [obj] = await stack.db.db
      .select()
      .from(mediaObject)
      .where(eq(mediaObject.id, aAsset.mediaObjectId!));
    expect(obj).toMatchObject({
      mimeType: 'image/png',
      width: 1,
      height: 1,
      byteSize: TINY_PNG_1x1.byteLength,
    });
    expect(obj!.storageKey).toMatch(new RegExp(`^ws/${workspaceId}/[0-9a-f]{64}\\.png$`));

    const served = await stack.app.inject({ method: 'GET', url: `/media/${obj!.storageKey}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.rawPayload.byteLength).toBe(TINY_PNG_1x1.byteLength);
    expect(
      (await stack.app.inject({ method: 'GET', url: '/media/../etc/passwd' })).statusCode,
    ).toBe(404);
    expect(
      (await stack.app.inject({ method: 'GET', url: `/media/ws/${workspaceId}/nope.png` }))
        .statusCode,
    ).toBe(404);

    // Publishing reuses the stored bytes: no download from the file host.
    const downloads = fake.requests.filter((r) => r.url === `${FILES_HOST}/one.png`).length;
    await publishAll(a.pubs);
    expect(fake.requests.filter((r) => r.url === `${FILES_HOST}/one.png`).length).toBe(downloads);
    expect(provider.calls.at(-1)!.uploaded[0]?.contentHash).toBe(obj!.contentHash);
    fake.notion.upsert(b.pageId, { status: 'Cancelled' });
    await sync();
  });

  it('derives a spec-conforming variant for url-delivery providers and hands over a public URL', async () => {
    const urlProvider = new FakeProvider({
      capabilities: {
        imageRequired: true,
        image: {
          delivery: 'url',
          outputMimeType: 'image/jpeg',
          minWidth: 320,
          maxWidth: 1440,
          minAspect: 0.8,
          maxAspect: 1.91,
        },
      },
    });
    const engine = new PublishEngine({
      db: stack.db.db,
      providers: createProviderRegistry([], { fallback: urlProvider }),
      socialAccounts: stack.services.socialAccounts,
      media: stack.services.media,
      enqueue: stack.enqueue,
      clock: stack.clock,
      logger: pino({ level: 'silent' }),
      workerId: 'url-worker',
    });
    // A 1×1 PNG must become a ≥320 px JPEG; a 320×240 JPEG already fits and is served as is.
    const png = await duePage({
      platforms: ['Instagram'],
      media: [{ name: 'tiny.png', url: `${FILES_HOST}/tiny.png` }],
    });
    const jpg = await duePage({
      platforms: ['Instagram'],
      media: [{ name: 'photo.jpg', url: `${FILES_HOST}/photo.jpg` }],
    });
    await stack.services.scheduler.tick('p2-url');
    expect(await engine.handle({ publicationId: png.pubs[0]!.id, cycleNo: 0 }, 'u1')).toBe(
      'published',
    );
    expect(await engine.handle({ publicationId: jpg.pubs[0]!.id, cycleNo: 0 }, 'u2')).toBe(
      'published',
    );

    const [derived, original] = urlProvider.calls.map((c) => c.urls[0]!);
    expect(derived).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 320 });
    expect(derived!.url).toMatch(
      /^http:\/\/localhost\/media\/ws\/.+-jpeg-min320-w1440-a0\.80-1\.91\.jpg$/,
    );
    expect(original).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 240 });
    expect(original!.url).toMatch(/\.jpg$/);
    expect(original!.url).not.toContain('-jpeg-');

    const fetched = await stack.app.inject({ method: 'GET', url: new URL(derived!.url).pathname });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/jpeg');
    expect(fetched.rawPayload[0]).toBe(0xff); // JPEG SOI

    // The variant is recorded once and reused on retry.
    const [asset] = await stack.db.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.postId, png.post.id));
    const [obj] = await stack.db.db
      .select()
      .from(mediaObject)
      .where(eq(mediaObject.id, asset!.mediaObjectId!));
    expect(Object.keys(obj!.variants as object)).toEqual(['jpeg-min320-w1440-a0.80-1.91']);
  });

  it('prunes stored objects that nothing references after the retention window', async () => {
    const [obj] = await stack.db.db
      .insert(mediaObject)
      .values({
        id: '01a0dc70-0000-7000-8000-000000000001',
        workspaceId,
        contentHash: 'f'.repeat(64),
        storageKey: `ws/${workspaceId}/${'f'.repeat(64)}.png`,
        mimeType: 'image/png',
        byteSize: 1,
        lastReferencedAt: new Date(stack.clock.now().getTime() - 8 * 24 * 3_600_000),
      })
      .returning();
    await stack.services.storage.put(obj!.storageKey, TINY_PNG_1x1, 'image/png');
    expect(await stack.services.media.pruneUnreferenced()).toBeGreaterThanOrEqual(1);
    expect(await stack.services.storage.get(obj!.storageKey)).toBeNull();
    expect(
      (await stack.db.db.select().from(mediaObject).where(eq(mediaObject.id, obj!.id))).length,
    ).toBe(0);
    // Referenced objects survive regardless of age.
    const referenced = await stack.db.db
      .select({ id: mediaObject.id })
      .from(mediaObject)
      .where(eq(mediaObject.workspaceId, workspaceId));
    expect(referenced.length).toBeGreaterThan(0);
  });

  it('exposes the text fingerprint used by reconciliation for overrides too', () => {
    expect(textFingerprint(' Short  tweet version ')).toBe(textFingerprint('Short tweet version'));
  });
});
