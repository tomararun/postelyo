import { describe, expect, it } from 'vitest';
import { runProviderContractSuite } from '../../provider-contract.js';
import type { LoadedMedia, ProviderContext, PublishInput } from '../../provider.js';
import { textFingerprint } from '../../render.js';
import {
  LINKEDIN_API_VERSION,
  LINKEDIN_IMAGES_INIT_URL,
  LINKEDIN_POSTS_URL,
  LinkedInProvider,
} from './linkedin-provider.js';

// Local test doubles: provider adapters (and their tests) may not import outside modules/publishing.
function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init ?? {},
    );
}
const bodyToString = (b: RequestInit['body']): string => (typeof b === 'string' ? b : '');

const UPLOAD_URL = 'https://www.linkedin.com/dms-uploads/abc';
const IMAGE_URN = 'urn:li:image:C4D22AQ';

/** A fake LinkedIn that accepts uploads, posts and author lookups, and records what it saw. */
function linkedInFake(
  overrides: Partial<Record<'init' | 'put' | 'post' | 'lookup', () => Response>> = {},
) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    seen.push({ url, init });
    if (url.startsWith(LINKEDIN_POSTS_URL + '?') && (init.method ?? 'GET') === 'GET') {
      return (
        overrides.lookup?.() ?? new Response(JSON.stringify({ elements: [] }), { status: 200 })
      );
    }
    if (url === LINKEDIN_IMAGES_INIT_URL) {
      return (
        overrides.init?.() ??
        new Response(JSON.stringify({ value: { uploadUrl: UPLOAD_URL, image: IMAGE_URN } }), {
          status: 200,
        })
      );
    }
    if (url === UPLOAD_URL) return overrides.put?.() ?? new Response('', { status: 201 });
    if (url === LINKEDIN_POSTS_URL) {
      return (
        overrides.post?.() ??
        new Response('', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7000' } })
      );
    }
    return new Response('unexpected', { status: 599 });
  });
  return { fetchImpl, seen };
}

runProviderContractSuite(
  'LinkedInProvider',
  () => new LinkedInProvider({ fetchImpl: linkedInFake().fetchImpl }),
);

const account = {
  id: 'acc',
  workspaceId: 'ws',
  provider: 'linkedin' as const,
  accountType: 'member' as const,
  providerAccountId: 'abc123',
  displayName: 'Alice',
};
const ctx: ProviderContext = {
  credentials: { accessToken: 'AQV-token' },
  correlationId: 'c',
  timeoutMs: 1000,
};
const textInput: PublishInput = {
  publicationId: 'pub',
  account,
  content: { text: 'Hello \\(world\\)', plainText: 'Hello (world)', media: [] },
};
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const loaded: LoadedMedia = {
  assetId: 'asset-1',
  bytes: pngBytes,
  mimeType: 'image/png',
  byteSize: pngBytes.byteLength,
  contentHash: 'h'.repeat(64),
};

describe('LinkedInProvider.publish (text)', () => {
  it('posts to the Posts API with the pinned version and returns the urn from x-restli-id', async () => {
    const li = linkedInFake();
    const r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(textInput, ctx);
    expect(r).toMatchObject({
      kind: 'published',
      providerPostId: 'urn:li:share:7000',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:7000',
    });
    expect(li.seen.map((s) => s.url)).toEqual([LINKEDIN_POSTS_URL]);
    const headers = li.seen[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer AQV-token');
    expect(headers['linkedin-version']).toBe(LINKEDIN_API_VERSION);
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
    const body = JSON.parse(bodyToString(li.seen[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      author: 'urn:li:person:abc123',
      commentary: 'Hello \\(world\\)',
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
    });
    expect(body['content']).toBeUndefined();
  });

  it('classifies HTTP outcomes of the post call into exactly one result kind', async () => {
    const cases: [number, string, string, Record<string, string>?][] = [
      [401, '{"message":"expired"}', 'terminal_error:auth'],
      [403, '{"message":"Not enough permissions to access: posts"}', 'terminal_error:permission'],
      [403, '{"message":"forbidden"}', 'terminal_error:auth'],
      [400, '{"message":"commentary too long"}', 'terminal_error:content'],
      [400, '{"message":"Media not available for processing"}', 'retryable_error'],
      [422, '{}', 'terminal_error:content'],
      [429, '', 'retryable_error', { 'retry-after': '30' }],
      [503, '', 'retryable_error'],
      [500, '', 'ambiguous'],
      [201, '', 'ambiguous'], // success without an id
    ];
    for (const [status, body, expected, headers] of cases) {
      const init: ResponseInit = headers ? { status, headers } : { status };
      const li = linkedInFake({ post: () => new Response(body, init) });
      const r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(textInput, ctx);
      const got = r.kind === 'terminal_error' ? `${r.kind}:${r.code}` : r.kind;
      expect(got, `status ${status} ${body}`).toBe(expected);
      if (status === 429) expect(r).toMatchObject({ retryAfterMs: 30_000 });
    }
  });

  it('classifies network failures: unreachable is retryable, timeouts on the post call are ambiguous', async () => {
    const refused = new LinkedInProvider({
      fetchImpl: fakeFetch(() => {
        throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
      }),
    });
    expect((await refused.publish(textInput, ctx)).kind).toBe('retryable_error');
    const timeout = new LinkedInProvider({
      fetchImpl: fakeFetch(() => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }),
    });
    expect((await timeout.publish(textInput, ctx)).kind).toBe('ambiguous');
  });
});

describe('LinkedInProvider organization pages and lookups', () => {
  const page = {
    ...account,
    id: 'acc-org',
    accountType: 'organization' as const,
    providerAccountId: '424242',
  };

  it('posts as the organization and uploads images owned by it', async () => {
    const li = linkedInFake();
    const r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(
      {
        publicationId: 'pub',
        account: page,
        content: {
          text: 'Page news',
          plainText: 'Page news',
          media: [{ assetId: 'asset-1', mimeType: 'image/png', byteSize: 12 }],
        },
        loadMedia: async () => loaded,
      },
      ctx,
    );
    expect(r.kind).toBe('published');
    expect(JSON.parse(bodyToString(li.seen[0]!.init.body))).toEqual({
      initializeUploadRequest: { owner: 'urn:li:organization:424242' },
    });
    const post = JSON.parse(bodyToString(li.seen[2]!.init.body)) as { author: string };
    expect(post.author).toBe('urn:li:organization:424242');
  });

  it('treats 429 as a rate-limit wait with the Retry-After or a default', async () => {
    const withHeader = linkedInFake({
      post: () =>
        new Response('{"message":"daily limit"}', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    });
    const a = await new LinkedInProvider({ fetchImpl: withHeader.fetchImpl }).publish(
      textInput,
      ctx,
    );
    expect(a).toMatchObject({ kind: 'retryable_error', code: 'rate_limit', retryAfterMs: 120_000 });
    const without = linkedInFake({ post: () => new Response('', { status: 429 }) });
    const b = await new LinkedInProvider({ fetchImpl: without.fetchImpl }).publish(textInput, ctx);
    expect(b).toMatchObject({
      kind: 'retryable_error',
      code: 'rate_limit',
      retryAfterMs: 15 * 60_000,
    });
  });

  it('lookupRecent queries posts by author and fingerprints the unescaped commentary', async () => {
    const li = linkedInFake({
      lookup: () =>
        new Response(
          JSON.stringify({
            elements: [
              {
                id: 'urn:li:share:1',
                commentary: 'Hello \\(world\\) {hashtag|\\#|launch}',
                publishedAt: 1_800_000_000_000,
              },
              { id: 'urn:li:share:2', commentary: 'older', publishedAt: 1_000 },
              { commentary: 'no id' },
            ],
          }),
          { status: 200 },
        ),
    });
    const refs = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).lookupRecent(
      page,
      new Date(1_700_000_000_000),
      ctx,
    );
    const u = new URL(li.seen[0]!.url);
    expect(u.searchParams.get('q')).toBe('author');
    expect(u.searchParams.get('author')).toBe('urn:li:organization:424242');
    expect((li.seen[0]!.init.headers as Record<string, string>)['linkedin-version']).toBe(
      LINKEDIN_API_VERSION,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      providerPostId: 'urn:li:share:1',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:1',
      textHash: textFingerprint('Hello (world) #launch'),
    });
    expect(refs[0]!.publishedAt?.getTime()).toBe(1_800_000_000_000);
  });

  it('lookupRecent throws on transport failure so the reconciler can retry later', async () => {
    const li = linkedInFake({ lookup: () => new Response('{"message":"nope"}', { status: 403 }) });
    await expect(
      new LinkedInProvider({ fetchImpl: li.fetchImpl }).lookupRecent(account, new Date(0), ctx),
    ).rejects.toThrow(/403/);
  });
});

describe('LinkedInProvider.publish (image)', () => {
  const imageInput = (extra: Partial<PublishInput> = {}): PublishInput => ({
    publicationId: 'pub',
    account,
    content: {
      text: 'With picture',
      plainText: 'With picture',
      media: [{ assetId: 'asset-1', mimeType: 'image/png', byteSize: 12, alt: 'A hero image' }],
    },
    loadMedia: async () => loaded,
    ...extra,
  });

  it('initializes the upload, PUTs the bytes, reports the urn and references it in the post', async () => {
    const li = linkedInFake();
    const uploaded: string[] = [];
    const r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(
      imageInput({
        onMediaUploaded: async (assetId, ref, hash) =>
          void uploaded.push(`${assetId}:${ref}:${hash.slice(0, 4)}`),
      }),
      ctx,
    );
    expect(r.kind).toBe('published');
    expect(li.seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `POST ${LINKEDIN_IMAGES_INIT_URL}`,
      `PUT ${UPLOAD_URL}`,
      `POST ${LINKEDIN_POSTS_URL}`,
    ]);
    expect(JSON.parse(bodyToString(li.seen[0]!.init.body))).toEqual({
      initializeUploadRequest: { owner: 'urn:li:person:abc123' },
    });
    expect(li.seen[1]!.init.body).toBe(pngBytes);
    expect((li.seen[1]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    const post = JSON.parse(bodyToString(li.seen[2]!.init.body)) as {
      content: { media: { id: string; altText: string } };
    };
    expect(post.content.media).toEqual({ id: IMAGE_URN, altText: 'A hero image' });
    expect(uploaded).toEqual([`asset-1:${IMAGE_URN}:hhhh`]);
  });

  it('reuses a cached provider reference without loading or uploading', async () => {
    const li = linkedInFake();
    let loads = 0;
    const input = imageInput({ loadMedia: async () => (loads++, loaded) });
    input.content.media[0]!.providerRef = 'urn:li:image:cached';
    const r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(input, ctx);
    expect(r.kind).toBe('published');
    expect(loads).toBe(0);
    expect(li.seen.map((s) => s.url)).toEqual([LINKEDIN_POSTS_URL]);
    const post = JSON.parse(bodyToString(li.seen[0]!.init.body)) as {
      content: { media: { id: string } };
    };
    expect(post.content.media.id).toBe('urn:li:image:cached');
  });

  it('classifies upload problems as retryable and unusable images as terminal, never creating a post', async () => {
    const initFails = linkedInFake({ init: () => new Response('', { status: 500 }) });
    let r = await new LinkedInProvider({ fetchImpl: initFails.fetchImpl }).publish(
      imageInput(),
      ctx,
    );
    expect(r.kind).toBe('retryable_error');
    expect(initFails.seen.some((s) => s.url === LINKEDIN_POSTS_URL)).toBe(false);

    const putFails = linkedInFake({ put: () => new Response('', { status: 503 }) });
    r = await new LinkedInProvider({ fetchImpl: putFails.fetchImpl }).publish(imageInput(), ctx);
    expect(r.kind).toBe('retryable_error');

    const putAuth = linkedInFake({ put: () => new Response('', { status: 401 }) });
    r = await new LinkedInProvider({ fetchImpl: putAuth.fetchImpl }).publish(imageInput(), ctx);
    expect(r).toMatchObject({ kind: 'terminal_error', code: 'auth' });

    const li = linkedInFake();
    r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(
      imageInput({
        loadMedia: async () => {
          throw Object.assign(new Error('not an image'), { code: 'not_an_image' });
        },
      }),
      ctx,
    );
    expect(r).toMatchObject({ kind: 'terminal_error', code: 'content' });
    r = await new LinkedInProvider({ fetchImpl: li.fetchImpl }).publish(
      imageInput({
        loadMedia: async () => {
          throw Object.assign(new Error('timeout'), { code: 'network' });
        },
      }),
      ctx,
    );
    expect(r.kind).toBe('retryable_error');
    expect(li.seen).toHaveLength(0);
  });

  it('validates image count, type and size on the enriched metadata', () => {
    const p = new LinkedInProvider({ fetchImpl: linkedInFake().fetchImpl });
    const one = p.validate(
      { text: 'x', plainText: 'x', media: [{ assetId: 'a', mimeType: 'image/png', byteSize: 10 }] },
      account,
    );
    expect(one).toEqual({ ok: true });
    const two = p.validate(
      {
        text: 'x',
        plainText: 'x',
        media: [
          { assetId: 'a', mimeType: 'image/png', byteSize: 1 },
          { assetId: 'b', mimeType: 'image/png', byteSize: 1 },
        ],
      },
      account,
    );
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.issues.map((i) => i.code)).toEqual(['TOO_MANY_IMAGES']);
    const bad = p.validate(
      {
        text: 'x',
        plainText: 'x',
        media: [{ assetId: 'a', mimeType: 'image/gif', byteSize: 9 * 1024 * 1024 }],
      },
      account,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.issues.map((i) => i.code).sort()).toEqual([
        'IMAGE_TOO_LARGE',
        'UNSUPPORTED_IMAGE_TYPE',
      ]);
  });
});
