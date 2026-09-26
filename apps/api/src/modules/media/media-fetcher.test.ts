import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../shared/fetch-utils.js';
import { MediaError, MediaFetcher, assertFetchableUrl, isPrivateAddress } from './media-fetcher.js';
import { TINY_JPEG_320x240, TINY_PNG_1x1 } from './test-images.js';

describe('assertFetchableUrl', () => {
  it('allows public http(s) and blocks local, private and non-http targets', () => {
    expect(assertFetchableUrl('https://cdn.example/a.png').hostname).toBe('cdn.example');
    for (const bad of [
      'ftp://x/a.png',
      'file:///etc/passwd',
      'http://localhost/a.png',
      'http://127.0.0.1/a.png',
      'http://10.1.2.3/a.png',
      'http://172.20.0.1/a.png',
      'http://192.168.1.1/a.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.png',
      'http://db.internal/a.png',
      'not a url',
    ]) {
      expect(() => assertFetchableUrl(bad), bad).toThrow(MediaError);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
  });
});

describe('MediaFetcher.fetchImage', () => {
  const serve = (body: Uint8Array | string, init: ResponseInit = {}) =>
    fakeFetch(() => new Response(body, { status: 200, ...init }));

  it('downloads, sniffs, hashes and measures a PNG regardless of declared content type', async () => {
    const f = new MediaFetcher({
      fetchImpl: serve(TINY_PNG_1x1, { headers: { 'content-type': 'application/octet-stream' } }),
    });
    const img = await f.fetchImage('https://cdn.example/hero.png');
    expect(img).toMatchObject({
      mimeType: 'image/png',
      byteSize: TINY_PNG_1x1.byteLength,
      width: 1,
      height: 1,
    });
    expect(img.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const jpg = await new MediaFetcher({ fetchImpl: serve(TINY_JPEG_320x240) }).fetchImage(
      'https://cdn.example/a.jpg',
    );
    expect(jpg).toMatchObject({ mimeType: 'image/jpeg', width: 320, height: 240 });
  });

  it('rejects non-images, unsupported types, oversize bodies and expired links', async () => {
    await expect(
      new MediaFetcher({ fetchImpl: serve('<html>nope</html>') }).fetchImage('https://x.example/a'),
    ).rejects.toMatchObject({ code: 'not_an_image' });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
    await expect(
      new MediaFetcher({ fetchImpl: serve(gif) }).fetchImage('https://x.example/a.gif'),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
    const big = new Uint8Array(2048);
    big.set(TINY_PNG_1x1, 0);
    await expect(
      new MediaFetcher({ fetchImpl: serve(big), maxBytes: 1024 }).fetchImage(
        'https://x.example/big.png',
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(
      new MediaFetcher({
        fetchImpl: serve(TINY_PNG_1x1, { headers: { 'content-length': '99999999' } }),
      }).fetchImage('https://x.example/a.png'),
    ).rejects.toMatchObject({ code: 'too_large' });
    await expect(
      new MediaFetcher({ fetchImpl: serve('', { status: 403 }) }).fetchImage(
        'https://s3.example/signed?x=1',
      ),
    ).rejects.toMatchObject({ code: 'expired' });
    await expect(
      new MediaFetcher({ fetchImpl: serve('', { status: 404 }) }).fetchImage(
        'https://s3.example/gone',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      new MediaFetcher({
        fetchImpl: fakeFetch(() => {
          throw new Error('ECONNRESET');
        }),
      }).fetchImage('https://x.example/a.png'),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
