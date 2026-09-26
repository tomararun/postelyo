import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { mediaAsset, post, publication } from '../../src/infra/db/schema.js';
import { TINY_PNG_1x1 } from '../../src/modules/media/test-images.js';
import type { FakeProvider } from '../../src/modules/publishing/providers/fake/fake-provider.js';
import {
  FILES_HOST,
  NOTION_GOOD_DB,
  NOTION_VALID_TOKEN,
  createFakeProviders,
} from './fake-providers.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

describe('images', () => {
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

  const load = async (externalId: string) => {
    const [p] = await stack.db.db.select().from(post).where(eq(post.externalId, externalId));
    const pubs = p
      ? await stack.db.db.select().from(publication).where(eq(publication.postId, p.id))
      : [];
    const assets = p
      ? await stack.db.db.select().from(mediaAsset).where(eq(mediaAsset.postId, p.id))
      : [];
    return { post: p!, pub: pubs[0], assets };
  };

  const duePage = (
    media: { name: string; url: string; kind?: 'external' | 'file' }[],
    body = 'Look at this',
  ) => {
    const id = `img-page-${++seq}`;
    fake.notion.upsert(id, {
      status: 'Scheduled',
      title: id,
      publishDate: { start: new Date(stack.clock.now().getTime() - 60_000).toISOString() },
      body: [body],
      media,
    });
    return id;
  };

  const publish = async (pubId: string, cycleNo: number) => {
    await stack.services.scheduler.tick(`t-${pubId}`);
    return stack.services.engine.handle({ publicationId: pubId, cycleNo }, `c-${pubId}`);
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: { LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret' },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('img')));
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
    provider = stack.services.providers.get('linkedin') as FakeProvider;
  });
  afterAll(async () => {
    // The scheduler tick is global; do not leave due publications behind for other suites.
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

  it('inspects an external image at sync time and stores hash, size, type and dimensions', async () => {
    const id = duePage([{ name: 'hero.png', url: `${FILES_HOST}/hero.png` }]);
    await sync();
    const { post: p, pub, assets } = await load(id);
    expect(p.validationErrors).toBeNull();
    expect(pub?.state).toBe('scheduled');
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      sourceKind: 'external',
      mimeType: 'image/png',
      byteSize: TINY_PNG_1x1.byteLength,
      width: 1,
      height: 1,
      lastError: null,
    });
    expect(assets[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(assets[0]?.inspectedAt).toBeInstanceOf(Date);
  });

  it('publishes with the image: bytes are loaded once, the upload ref is cached and reused on retry', async () => {
    const id = duePage(
      [{ name: 'hero.png', url: `${FILES_HOST}/hero.png` }],
      'Retry keeps the upload',
    );
    await sync();
    const { pub, assets } = await load(id);
    provider.scriptOutcomes({ kind: 'retryable_error', reason: 'flaky' });
    expect(await publish(pub!.id, pub!.cycleNo)).toBe('retry_scheduled');
    const first = provider.calls.at(-1)!;
    expect(first.uploaded).toHaveLength(1);
    expect(first.uploaded[0]).toMatchObject({
      assetId: assets[0]!.id,
      byteSize: TINY_PNG_1x1.byteLength,
      contentHash: assets[0]!.contentHash,
    });
    expect(first.reusedRefs).toEqual([]);

    const [afterUpload] = await stack.db.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.id, assets[0]!.id));
    const refs = afterUpload!.providerRefs as Record<string, { ref: string; contentHash: string }>;
    expect(refs['linkedin']).toMatchObject({
      ref: first.uploaded[0]!.ref,
      contentHash: assets[0]!.contentHash,
    });

    stack.clock.advance(60_000);
    expect(
      await stack.services.engine.handle(
        { publicationId: pub!.id, cycleNo: pub!.cycleNo },
        'retry',
      ),
    ).toBe('published');
    const second = provider.calls.at(-1)!;
    expect(second.uploaded).toEqual([]);
    expect(second.reusedRefs).toEqual([first.uploaded[0]!.ref]);
    expect(second.input.content.media[0]).toMatchObject({
      mimeType: 'image/png',
      byteSize: TINY_PNG_1x1.byteLength,
      alt: 'hero.png',
    });
    stack.clock.advance(-60_000);
  });

  it('refreshes an expired Notion-hosted file URL through the page before publishing', async () => {
    const id = duePage(
      [{ name: 'shot.png', url: 'uploads/shot.png', kind: 'file' }],
      'Notion hosted',
    );
    await sync();
    const { pub, assets } = await load(id);
    expect(assets[0]?.sourceKind).toBe('file');
    expect(assets[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/); // inspected while the URL was fresh
    const staleUrl = assets[0]!.sourceUrl;

    // Any Notion read since sync has rotated the signature, so the stored URL is stale.
    fake.notion.fileSig += 5;
    expect(await publish(pub!.id, pub!.cycleNo)).toBe('published');
    const call = provider.calls.at(-1)!;
    expect(call.uploaded).toHaveLength(1);
    const [refreshed] = await stack.db.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.id, assets[0]!.id));
    expect(refreshed?.sourceUrl).not.toBe(staleUrl);
    expect(refreshed?.sourceUrl).toContain('/uploads/shot.png?sig=');
    const fileGets = fake.requests.filter((r) => r.url.includes('/uploads/shot.png'));
    expect(fileGets.length).toBeGreaterThanOrEqual(2); // stale 403, then fresh 200
  });

  it('reports unusable images as validation errors before publish time', async () => {
    const notImage = duePage([{ name: 'page.html', url: `${FILES_HOST}/page.html` }]);
    const huge = duePage([{ name: 'huge.png', url: `${FILES_HOST}/huge.png` }]);
    const missing = duePage([{ name: 'gone.png', url: `${FILES_HOST}/gone.png` }]);
    const internal = duePage([
      { name: 'secret.png', url: 'http://169.254.169.254/latest/meta-data' },
    ]);
    const two = duePage([
      { name: 'a.png', url: `${FILES_HOST}/a.png` },
      { name: 'b.png', url: `${FILES_HOST}/b.png` },
    ]);
    await sync();
    for (const [id, code, fragment] of [
      [notImage, 'MEDIA_INVALID', 'not a recognised image'],
      [huge, 'MEDIA_INVALID', 'limit'],
      [missing, 'MEDIA_INVALID', 'not found'],
      [internal, 'MEDIA_INVALID', 'private network'],
      [two, 'TOO_MANY_IMAGES', 'image'],
    ] as const) {
      const { post: p, pub } = await load(id);
      const errors = p.validationErrors as { code: string; message: string }[];
      expect(
        errors.map((e) => e.code),
        id,
      ).toContain(code);
      expect(errors.map((e) => e.message).join(' '), id).toContain(fragment);
      expect(pub, id).toBeUndefined();
      expect(fake.notion.pages.get(id)?.system.postelyoStatus, id).toBe('Validation error');
    }
    const { assets } = await load(notImage);
    expect(assets[0]?.lastError).toContain('not a recognised image');
  });

  it('a replaced file is re-inspected and its cached upload invalidated', async () => {
    const id = duePage([{ name: 'pic.png', url: `${FILES_HOST}/pic.png` }], 'Swap the picture');
    await sync();
    const before = await load(id);
    await stack.services.media.recordProviderRef(
      before.assets[0]!.id,
      'linkedin',
      'urn:li:image:OLD',
      before.assets[0]!.contentHash!,
    );

    fake.notion.upsert(id, { media: [{ name: 'pic.png', url: `${FILES_HOST}/pic.jpg` }] });
    await sync();
    const after = await load(id);
    expect(after.assets).toHaveLength(1);
    expect(after.assets[0]).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 240 });
    expect(after.assets[0]?.providerRefs).toEqual({});
    expect(after.pub?.state).toBe('scheduled');
  });
});
