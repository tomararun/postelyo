/**
 * Image metadata from bytes: type sniffing and dimensions for PNG/JPEG. Content
 * from Notion is untrusted input (security.md §8), so we never trust the
 * declared content type or file extension alone.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const SUPPORTED_IMAGE_MIMES: readonly ImageMime[] = ['image/png', 'image/jpeg'];

export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return 'image/gif';
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Returns null when dimensions cannot be determined (unsupported type or truncated data). */
export function imageDimensions(bytes: Uint8Array, mime: ImageMime): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    // IHDR is always the first chunk: length(4) type(4) width(4) height(4)
    if (bytes.length < 24) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) return null;
      const marker = bytes[off + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        off += 2;
        continue;
      }
      const len = view.getUint16(off + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(off + 5), width: view.getUint16(off + 7) };
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
      off += 2 + len;
    }
    return null;
  }
  return null;
}
