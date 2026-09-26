/**
 * Minimal valid image byte sequences shared by unit and integration tests.
 * Kept in src so provider adapters (which may not import from test/) can use them.
 */

/** 1×1 transparent PNG (67 bytes). */
export const TINY_PNG_1x1 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/**
 * A JPEG header with a baseline SOF0 segment declaring 320×240, followed by EOI.
 * Enough for sniffing and dimension parsing; not a renderable picture.
 */
export const TINY_JPEG_320x240 = Uint8Array.from([
  0xff,
  0xd8, // SOI
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
  0x01,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00, // APP0 JFIF
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08,
  0x00,
  0xf0,
  0x01,
  0x40,
  0x03,
  0x01,
  0x22,
  0x00,
  0x02,
  0x11,
  0x01,
  0x03,
  0x11,
  0x01, // SOF0 240x320
  0xff,
  0xd9, // EOI
]);
