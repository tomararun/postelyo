import { describe, expect, it } from 'vitest';
import { runProviderContractSuite } from '../../provider-contract.js';
import type { ProviderContext, PublishInput } from '../../provider.js';
import { textFingerprint } from '../../render.js';
import { FacebookProvider } from './facebook-provider.js';
import { GRAPH_URL } from './graph.js';
import { InstagramProvider } from './instagram-provider.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init ?? {},
    );
}
const bodyParams = (b: RequestInit['body']) => new URLSearchParams(typeof b === 'string' ? b : '');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Graph API fake: page feed/photos, IG container/status/publish/permalink, lookups. */
function graphFake(overrides: Partial<Record<string, (init: RequestInit) => Response>> = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  let statusPolls = 0;
  const fetchImpl = fakeFetch((url, init) => {
    seen.push({ url, init });
    const path = url.replace(GRAPH_URL, '');
    const key = Object.keys(overrides).find((k) => path.startsWith(k));
    if (key) return overrides[key]!(init);
    // Id-agnostic routing so the shared contract suite (own account ids) passes too.
    if (/^\/[^/?]+\/feed$/.test(path) && init.method === 'POST')
      return json(200, { id: 'page-1_111' });
    if (/^\/[^/?]+\/photos$/.test(path)) return json(200, { id: '222', post_id: 'page-1_222' });
    if (/^\/[^/?]+\/feed\?/.test(path)) {
      return json(200, {
        data: [
          {
            id: 'page-1_9',
            message: 'Feed post',
            created_time: '2026-09-26T10:00:00+0000',
            permalink_url: 'https://www.facebook.com/page-1/posts/9',
          },
        ],
      });
    }
    if (/^\/[^/?]+\/media$/.test(path) && init.method === 'POST')
      return json(200, { id: 'container-1' });
    if (path.startsWith('/container-1?')) {
      statusPolls += 1;
      return json(200, { status_code: statusPolls >= 2 ? 'FINISHED' : 'IN_PROGRESS' });
    }
    if (/^\/[^/?]+\/media_publish$/.test(path)) return json(200, { id: 'ig-media-1' });
    if (path.startsWith('/ig-media-1?'))
      return json(200, { permalink: 'https://www.instagram.com/p/abc/' });
    if (/^\/[^/?]+\/media\?/.test(path)) {
      return json(200, {
        data: [
          {
            id: 'm1',
            caption: 'Caption here',
            timestamp: '2026-09-26T10:00:00+0000',
            permalink: 'https://www.instagram.com/p/m1/',
          },
        ],
      });
    }
    return new Response('unexpected ' + url, { status: 599 });
  });
  return { fetchImpl, seen };
}

const ctx: ProviderContext = {
  credentials: { accessToken: 'page-token' },
  correlationId: 'c',
  timeoutMs: 5000,
};
const page = {
  id: 'acc-fb',
  workspaceId: 'ws',
  provider: 'facebook' as const,
  accountType: 'page' as const,
  providerAccountId: 'page-1',
  displayName: 'Acme Page',
};
const ig = {
  id: 'acc-ig',
  workspaceId: 'ws',
  provider: 'instagram' as const,
  accountType: 'business' as const,
  providerAccountId: 'ig-1',
  displayName: '@acme',
};
const mediaUrl = async () => ({
  url: 'https://cdn.example/img.jpg',
  mimeType: 'image/jpeg',
  width: 1080,
  height: 1080,
  byteSize: 1000,
});

runProviderContractSuite(
  'FacebookProvider',
  () => new FacebookProvider({ fetchImpl: graphFake().fetchImpl }),
);

describe('FacebookProvider', () => {
  it('posts text to the page feed and images via /photos with a public URL', async () => {
    const g = graphFake();
    const p = new FacebookProvider({ fetchImpl: g.fetchImpl });
    const text = await p.publish(
      { publicationId: 'pub', account: page, content: { text: 'Hello page', media: [] } },
      ctx,
    );
    expect(text).toMatchObject({
      kind: 'published',
      providerPostId: 'page-1_111',
      url: 'https://www.facebook.com/page-1_111',
    });
    expect(bodyParams(g.seen[0]!.init.body).get('message')).toBe('Hello page');
    expect((g.seen[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer page-token',
    );

    const photo = await p.publish(
      {
        publicationId: 'pub2',
        account: page,
        content: { text: 'Pic', media: [{ assetId: 'a', mimeType: 'image/png', byteSize: 1 }] },
        mediaUrl,
      },
      ctx,
    );
    expect(photo).toMatchObject({ kind: 'published', providerPostId: 'page-1_222' });
    const params = bodyParams(g.seen[1]!.init.body);
    expect(params.get('url')).toBe('https://cdn.example/img.jpg');
    expect(params.get('message')).toBe('Pic');
  });

  it('classifies Graph errors', async () => {
    const cases: [number, unknown, string][] = [
      [
        400,
        { error: { code: 190, message: 'Error validating access token' } },
        'terminal_error:auth',
      ],
      [
        400,
        { error: { code: 4, message: 'Application request limit reached' } },
        'retryable_error',
      ],
      [
        403,
        { error: { code: 200, message: 'Requires pages_manage_posts' } },
        'terminal_error:permission',
      ],
      [400, { error: { code: 100, message: 'Invalid parameter' } }, 'terminal_error:content'],
      [500, { error: { code: 1, message: 'An unknown error occurred' } }, 'retryable_error'],
      [500, '', 'ambiguous'],
    ];
    for (const [status, body, expected] of cases) {
      const g = graphFake({
        '/page-1/feed': () =>
          new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      });
      const r = await new FacebookProvider({ fetchImpl: g.fetchImpl }).publish(
        { publicationId: 'pub', account: page, content: { text: 'x', media: [] } },
        ctx,
      );
      const got = r.kind === 'terminal_error' ? `${r.kind}:${r.code}` : r.kind;
      expect(got, `status ${status} ${JSON.stringify(body)}`).toBe(expected);
    }
  });

  it('lookupRecent reads the page feed', async () => {
    const refs = await new FacebookProvider({ fetchImpl: graphFake().fetchImpl }).lookupRecent(
      page,
      new Date(0),
      ctx,
    );
    expect(refs[0]).toMatchObject({
      providerPostId: 'page-1_9',
      url: 'https://www.facebook.com/page-1/posts/9',
      textHash: textFingerprint('Feed post'),
    });
  });
});

runProviderContractSuite(
  'InstagramProvider',
  () => new InstagramProvider({ fetchImpl: graphFake().fetchImpl, pollDelayMs: 1 }),
);

describe('InstagramProvider', () => {
  const withImage: PublishInput = {
    publicationId: 'pub',
    account: ig,
    content: { text: 'Caption #ok', media: [{ assetId: 'a', mimeType: 'image/png', byteSize: 1 }] },
    mediaUrl,
  };

  it('requires an image and a url-delivered JPEG variant within the aspect range', () => {
    const p = new InstagramProvider();
    const r = p.validate({ text: 'no image', media: [] }, ig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('IMAGE_REQUIRED');
    expect(p.capabilities().image).toMatchObject({
      delivery: 'url',
      outputMimeType: 'image/jpeg',
      minAspect: 0.8,
      maxAspect: 1.91,
    });
  });

  it('creates a container, waits for FINISHED, publishes and resolves the permalink', async () => {
    const g = graphFake();
    const r = await new InstagramProvider({ fetchImpl: g.fetchImpl, pollDelayMs: 1 }).publish(
      withImage,
      ctx,
    );
    expect(r).toMatchObject({
      kind: 'published',
      providerPostId: 'ig-media-1',
      url: 'https://www.instagram.com/p/abc/',
    });
    const paths = g.seen.map((s) => s.url.replace(GRAPH_URL, '').split('?')[0]);
    expect(paths).toEqual([
      '/ig-1/media',
      '/container-1',
      '/container-1',
      '/ig-1/media_publish',
      '/ig-media-1',
    ]);
    const create = bodyParams(g.seen[0]!.init.body);
    expect(create.get('image_url')).toBe('https://cdn.example/img.jpg');
    expect(create.get('caption')).toBe('Caption #ok');
    expect(bodyParams(g.seen[3]!.init.body).get('creation_id')).toBe('container-1');
  });

  it('never publishes when the container fails or stays in progress', async () => {
    const failed = graphFake({ '/container-1': () => json(200, { status_code: 'ERROR' }) });
    let r = await new InstagramProvider({ fetchImpl: failed.fetchImpl, pollDelayMs: 1 }).publish(
      withImage,
      ctx,
    );
    expect(r).toMatchObject({ kind: 'terminal_error', code: 'content' });
    expect(failed.seen.some((s) => s.url.endsWith('/media_publish'))).toBe(false);

    const slow = graphFake({ '/container-1': () => json(200, { status_code: 'IN_PROGRESS' }) });
    r = await new InstagramProvider({ fetchImpl: slow.fetchImpl, pollDelayMs: 1 }).publish(
      withImage,
      ctx,
    );
    expect(r).toMatchObject({ kind: 'retryable_error', retryAfterMs: 60_000 });
    expect(slow.seen.some((s) => s.url.endsWith('/media_publish'))).toBe(false);

    const noResponse = graphFake({
      '/ig-1/media_publish': () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    r = await new InstagramProvider({ fetchImpl: noResponse.fetchImpl, pollDelayMs: 1 }).publish(
      withImage,
      ctx,
    );
    expect(r.kind).toBe('ambiguous');
  });

  it('lookupRecent fingerprints captions', async () => {
    const refs = await new InstagramProvider({ fetchImpl: graphFake().fetchImpl }).lookupRecent(
      ig,
      new Date(0),
      ctx,
    );
    expect(refs[0]).toMatchObject({
      providerPostId: 'm1',
      url: 'https://www.instagram.com/p/m1/',
      textHash: textFingerprint('Caption here'),
    });
  });
});
