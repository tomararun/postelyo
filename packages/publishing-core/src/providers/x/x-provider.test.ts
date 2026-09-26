import { describe, expect, it } from 'vitest';
import { runProviderContractSuite } from '../../provider-contract.js';
import type { LoadedMedia, ProviderContext, PublishInput } from '../../provider.js';
import { textFingerprint } from '../../render.js';
import { X_MEDIA_UPLOAD_URL, X_TWEETS_URL, XProvider, weightedLength } from './x-provider.js';

// Local test doubles: adapters and their tests may not import outside the package root.
function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init ?? {},
    );
}
const bodyToString = (b: RequestInit['body']): string => (typeof b === 'string' ? b : '');

function xFake(overrides: Partial<Record<'upload' | 'tweet' | 'lookup', () => Response>> = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = fakeFetch((url, init) => {
    seen.push({ url, init });
    if (url === X_MEDIA_UPLOAD_URL) {
      return (
        overrides.upload?.() ??
        new Response(JSON.stringify({ data: { id: 'media-1' } }), { status: 200 })
      );
    }
    if (url === X_TWEETS_URL) {
      return (
        overrides.tweet?.() ??
        new Response(JSON.stringify({ data: { id: '1700000000', text: 'x' } }), { status: 201 })
      );
    }
    if (url.includes('/tweets?')) {
      return overrides.lookup?.() ?? new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response('unexpected', { status: 599 });
  });
  return { fetchImpl, seen };
}

runProviderContractSuite('XProvider', () => new XProvider({ fetchImpl: xFake().fetchImpl }));

const account = {
  id: 'acc',
  workspaceId: 'ws',
  provider: 'x' as const,
  accountType: 'member' as const,
  providerAccountId: '12345',
  displayName: '@alice',
};
const ctx: ProviderContext = {
  credentials: { accessToken: 'xt' },
  correlationId: 'c',
  timeoutMs: 1000,
};
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const loaded: LoadedMedia = {
  assetId: 'asset-1',
  bytes: png,
  mimeType: 'image/png',
  byteSize: png.byteLength,
  contentHash: 'h'.repeat(64),
};

describe('weightedLength', () => {
  it('counts URLs as 23 characters', () => {
    expect(weightedLength('hello')).toBe(5);
    expect(weightedLength('see https://example.com/a/very/long/path/that/goes/on ok')).toBe(
      4 + 23 + 3,
    );
  });
});

describe('XProvider', () => {
  it('renders the X-specific text override when present and validates the weighted length', () => {
    const p = new XProvider();
    const rendered = p.render(
      {
        postId: 'p',
        workspaceId: 'w',
        title: 't',
        contentHash: 'h',
        content: {
          v: 1,
          blocks: [{ type: 'paragraph', inlines: [{ t: 'text', text: 'long body' }] }],
          media: [],
          platformText: { x: 'short tweet' },
          meta: { source: 'notion' },
        },
      },
      account,
    );
    expect(rendered.text).toBe('short tweet');
    const tooLong = p.validate({ text: 'x'.repeat(281), media: [] }, account);
    expect(tooLong.ok).toBe(false);
  });

  it('uploads the image then creates the tweet, and caches the media id', async () => {
    const x = xFake();
    const uploaded: string[] = [];
    const input: PublishInput = {
      publicationId: 'pub',
      account,
      content: {
        text: 'With picture',
        media: [{ assetId: 'asset-1', mimeType: 'image/png', byteSize: 12 }],
      },
      loadMedia: async () => loaded,
      onMediaUploaded: async (assetId, ref) => void uploaded.push(`${assetId}:${ref}`),
    };
    const r = await new XProvider({ fetchImpl: x.fetchImpl }).publish(input, ctx);
    expect(r).toMatchObject({
      kind: 'published',
      providerPostId: '1700000000',
      url: 'https://x.com/i/status/1700000000',
    });
    expect(x.seen.map((s) => s.url)).toEqual([X_MEDIA_UPLOAD_URL, X_TWEETS_URL]);
    expect(x.seen[0]!.init.body).toBeInstanceOf(FormData);
    expect((x.seen[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer xt');
    expect(JSON.parse(bodyToString(x.seen[1]!.init.body))).toEqual({
      text: 'With picture',
      media: { media_ids: ['media-1'] },
    });
    expect(uploaded).toEqual(['asset-1:media-1']);
  });

  it('classifies tweet outcomes and rate limits', async () => {
    const cases: [number, string, string, Record<string, string>?][] = [
      [401, '{"title":"Unauthorized"}', 'terminal_error:auth'],
      [
        403,
        '{"detail":"You are not allowed to create a Tweet with duplicate content."}',
        'terminal_error:content',
      ],
      [403, '{"detail":"forbidden"}', 'terminal_error:permission'],
      [400, '{"errors":[{"message":"too long"}]}', 'terminal_error:content'],
      [
        429,
        '',
        'retryable_error',
        { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 90) },
      ],
      [503, '', 'retryable_error'],
      [500, '', 'ambiguous'],
    ];
    for (const [status, body, expected, headers] of cases) {
      const x = xFake({
        tweet: () => new Response(body, headers ? { status, headers } : { status }),
      });
      const r = await new XProvider({ fetchImpl: x.fetchImpl }).publish(
        { publicationId: 'pub', account, content: { text: 'hi', media: [] } },
        ctx,
      );
      const got = r.kind === 'terminal_error' ? `${r.kind}:${r.code}` : r.kind;
      expect(got, `status ${status}`).toBe(expected);
      if (status === 429) {
        expect(r).toMatchObject({ code: 'rate_limit' });
        expect((r as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(60_000);
      }
    }
  });

  it('lookupRecent fingerprints tweet text', async () => {
    const x = xFake({
      lookup: () =>
        new Response(
          JSON.stringify({
            data: [{ id: '1', text: 'Hello world', created_at: '2026-09-26T10:00:00.000Z' }],
          }),
          { status: 200 },
        ),
    });
    const refs = await new XProvider({ fetchImpl: x.fetchImpl }).lookupRecent(
      account,
      new Date(0),
      ctx,
    );
    expect(refs).toEqual([
      {
        providerPostId: '1',
        url: 'https://x.com/i/status/1',
        publishedAt: new Date('2026-09-26T10:00:00.000Z'),
        textHash: textFingerprint('Hello world'),
      },
    ]);
    expect(x.seen[0]!.url).toContain('/2/users/12345/tweets?');
  });
});
