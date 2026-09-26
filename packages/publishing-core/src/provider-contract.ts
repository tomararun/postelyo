import { describe, expect, it } from 'vitest';
import type {
  LoadedMedia,
  PostSnapshot,
  PublishingProvider,
  SocialAccountRef,
} from './provider.js';

/**
 * Conformance suite every PublishingProvider must pass (architecture §16).
 * Providers that talk to real APIs run it against recorded HTTP fixtures.
 */
export function runProviderContractSuite(name: string, make: () => PublishingProvider): void {
  const member: SocialAccountRef = {
    id: 'acc-1',
    workspaceId: 'ws-1',
    provider: 'fake',
    accountType: 'member',
    providerAccountId: 'provider-user-1',
    displayName: 'Contract Account',
  };
  const organization: SocialAccountRef = {
    ...member,
    id: 'acc-2',
    accountType: 'organization',
    providerAccountId: '424242',
    displayName: 'Contract Page',
  };
  const account = member;
  const snapshot = (text: string, withImage = false): PostSnapshot => ({
    postId: 'post-1',
    workspaceId: 'ws-1',
    title: 't',
    content: {
      v: 1,
      blocks: [{ type: 'paragraph', inlines: [{ t: 'text', text }] }],
      media: withImage ? [{ assetId: 'asset-1', kind: 'image', alt: 'alt text' }] : [],
      meta: { source: 'notion' },
    },
    contentHash: 'h',
  });
  const ctx = { credentials: { accessToken: 'token' }, correlationId: 'corr', timeoutMs: 5000 };
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const loaded: LoadedMedia = {
    assetId: 'asset-1',
    bytes: png,
    mimeType: 'image/png',
    byteSize: png.byteLength,
    contentHash: 'a'.repeat(64),
  };

  describe(`${name} provider contract`, () => {
    it('declares sane capabilities', () => {
      const caps = make().capabilities();
      expect(caps.maxTextLength).toBeGreaterThan(0);
      expect(caps.maxImages).toBeGreaterThanOrEqual(0);
      expect(caps.maxImageBytes).toBeGreaterThan(0);
    });

    it('renders a snapshot to non-empty text', () => {
      const p = make();
      const rendered = p.render(snapshot('hello world'), account);
      expect(rendered.text).toContain('hello world');
    });

    it('validates within capabilities and rejects over-long text', () => {
      const p = make();
      const caps = p.capabilities();
      // Providers that require an image (Instagram) are validated with one attached.
      const withImage = caps.imageRequired === true;
      expect(p.validate(p.render(snapshot('ok', withImage), account), account)).toEqual({
        ok: true,
      });
      const tooLong = p.validate(
        p.render(snapshot('x'.repeat(caps.maxTextLength + 1), withImage), account),
        account,
      );
      expect(tooLong.ok).toBe(false);
      if (!tooLong.ok) expect(tooLong.issues.map((i) => i.code)).toContain('TEXT_TOO_LONG');
    });

    it('rejects empty text', () => {
      const p = make();
      const r = p.validate({ text: '   ', media: [] }, account);
      expect(r.ok).toBe(false);
    });

    it('publish resolves to exactly one result kind and never throws for a normal call', async () => {
      const p = make();
      const rendered = p.render(snapshot('contract publish'), account);
      const result = await p.publish({ publicationId: 'pub-1', account, content: rendered }, ctx);
      expect(['published', 'retryable_error', 'terminal_error', 'ambiguous']).toContain(
        result.kind,
      );
      if (result.kind === 'published') expect(result.providerPostId.length).toBeGreaterThan(0);
    });

    it('publishes with an image through loadMedia and reports the upload, when images are supported', async () => {
      const p = make();
      if (p.capabilities().maxImages === 0) return;
      const rendered = p.render(snapshot('with image', true), account);
      expect(rendered.media).toHaveLength(1);
      const uploads: string[] = [];
      let loads = 0;
      let urls = 0;
      const urlDelivery = p.capabilities().image?.delivery === 'url';
      const result = await p.publish(
        {
          publicationId: 'pub-2',
          account,
          content: {
            ...rendered,
            media: rendered.media.map((m) => ({
              ...m,
              mimeType: 'image/png',
              byteSize: png.byteLength,
            })),
          },
          loadMedia: async () => {
            loads += 1;
            return loaded;
          },
          mediaUrl: async () => {
            urls += 1;
            return {
              url: 'https://cdn.example/asset-1.jpg',
              mimeType: 'image/jpeg',
              width: 1080,
              height: 1080,
              byteSize: 1000,
            };
          },
          onMediaUploaded: async (assetId, ref) => {
            uploads.push(`${assetId}:${ref}`);
          },
        },
        ctx,
      );
      expect(result.kind).toBe('published');
      if (urlDelivery) {
        // URL-delivery adapters never receive bytes; the engine hands them a public variant.
        expect(urls).toBe(1);
        expect(loads).toBe(0);
      } else {
        expect(loads).toBe(1);
        expect(uploads).toHaveLength(1);
        expect(uploads[0]).toMatch(/^asset-1:.+/);
      }
    });

    it('publishes for an organization account with the same result vocabulary', async () => {
      const p = make();
      const rendered = p.render(
        snapshot('page post', p.capabilities().imageRequired === true),
        organization,
      );
      expect(p.validate(rendered, organization)).toEqual({ ok: true });
      const result = await p.publish(
        { publicationId: 'pub-org', account: organization, content: rendered },
        ctx,
      );
      expect(['published', 'retryable_error', 'terminal_error', 'ambiguous']).toContain(
        result.kind,
      );
    });

    it('lookupRecent, when implemented, returns refs with ids and fingerprints and never a bare throw for empty results', async () => {
      const p = make();
      if (!p.lookupRecent) return;
      const refs = await p.lookupRecent(account, new Date(0), ctx);
      expect(Array.isArray(refs)).toBe(true);
      for (const r of refs) {
        expect(r.providerPostId.length).toBeGreaterThan(0);
        if (r.textHash !== undefined) expect(r.textHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('comment, when declared, resolves to posted or failed and never throws', async () => {
      const p = make();
      if (!p.capabilities().firstComment) {
        expect(typeof p.comment).toBe('undefined');
        return;
      }
      expect(typeof p.comment).toBe('function');
      const result = await p.comment!(
        { publicationId: 'pub-1', account, providerPostId: 'post-id-1', text: 'first comment' },
        ctx,
      );
      expect(['posted', 'failed']).toContain(result.kind);
      if (result.kind === 'posted') expect(result.commentId.length).toBeGreaterThan(0);
      else expect(typeof result.retryable).toBe('boolean');
    });

    it('metrics, when declared, resolve to metrics or unavailable and never throw', async () => {
      const p = make();
      if (!p.capabilities().metrics) {
        expect(typeof p.metrics).toBe('undefined');
        return;
      }
      expect(typeof p.metrics).toBe('function');
      const result = await p.metrics!(
        { publicationId: 'pub-1', account, providerPostId: 'post-id-1' },
        ctx,
      );
      expect(['metrics', 'unavailable']).toContain(result.kind);
      if (result.kind === 'metrics') {
        for (const v of Object.values(result.metrics)) {
          expect(v === null || (typeof v === 'number' && Number.isFinite(v))).toBe(true);
        }
      } else {
        expect(typeof result.retryable).toBe('boolean');
      }
    });

    it('rejects more images than supported', () => {
      const p = make();
      const caps = p.capabilities();
      const media = Array.from({ length: caps.maxImages + 1 }, (_, i) => ({
        assetId: `a${i}`,
        mimeType: 'image/png',
        byteSize: 1,
      }));
      const r = p.validate({ text: 'x', media }, account);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('TOO_MANY_IMAGES');
    });
  });
}
