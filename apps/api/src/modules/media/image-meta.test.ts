import { describe, expect, it } from 'vitest';
import { imageDimensions, sniffImageMime } from './image-meta.js';
import { TINY_JPEG_320x240, TINY_PNG_1x1 } from './test-images.js';

describe('sniffImageMime', () => {
  it('recognises png, jpeg, gif and webp signatures and rejects others', () => {
    expect(sniffImageMime(TINY_PNG_1x1)).toBe('image/png');
    expect(sniffImageMime(TINY_JPEG_320x240)).toBe('image/jpeg');
    expect(
      sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])),
    ).toBe('image/gif');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageMime(webp)).toBe('image/webp');
    expect(
      sniffImageMime(new TextEncoder().encode('<html><body>not an image</body></html>')),
    ).toBeNull();
    expect(sniffImageMime(new Uint8Array(3))).toBeNull();
  });
});

describe('imageDimensions', () => {
  it('reads PNG IHDR and JPEG SOF dimensions', () => {
    expect(imageDimensions(TINY_PNG_1x1, 'image/png')).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(TINY_JPEG_320x240, 'image/jpeg')).toEqual({ width: 320, height: 240 });
    expect(imageDimensions(TINY_PNG_1x1.subarray(0, 10), 'image/png')).toBeNull();
    expect(imageDimensions(TINY_JPEG_320x240.subarray(0, 4), 'image/jpeg')).toBeNull();
  });
});
