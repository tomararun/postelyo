import sharp from 'sharp';
import type { ImageSpec } from '@postelyo/publishing-core';

/**
 * Derived image variants for URL-delivery providers (Phase 2). A variant
 * satisfies a provider's ImageSpec: output type, width bounds and aspect
 * range. Aspect is corrected by centre-cropping toward the nearest bound so
 * nothing is stretched; width is clamped by resizing.
 */

export interface DerivedVariant {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/** Stable key for a spec, used as the variant name in `media_object.variants`. */
export function variantKey(spec: ImageSpec): string {
  const parts = [spec.outputMimeType === 'image/png' ? 'png' : 'jpeg'];
  if (spec.minWidth) parts.push(`min${spec.minWidth}`);
  if (spec.maxWidth) parts.push(`w${spec.maxWidth}`);
  if (spec.minAspect !== undefined || spec.maxAspect !== undefined) {
    parts.push(`a${(spec.minAspect ?? 0).toFixed(2)}-${(spec.maxAspect ?? 99).toFixed(2)}`);
  }
  return parts.join('-');
}

/** True when the source already satisfies the spec (no derivation needed). */
export function satisfiesSpec(
  src: { mimeType: string; width: number | null; height: number | null },
  spec: ImageSpec,
): boolean {
  const target = spec.outputMimeType ?? src.mimeType;
  if (src.mimeType !== target) return false;
  if (src.width === null || src.height === null || src.height === 0) return false;
  if (spec.maxWidth && src.width > spec.maxWidth) return false;
  if (spec.minWidth && src.width < spec.minWidth) return false;
  const aspect = src.width / src.height;
  if (spec.minAspect !== undefined && aspect < spec.minAspect - 1e-6) return false;
  if (spec.maxAspect !== undefined && aspect > spec.maxAspect + 1e-6) return false;
  return true;
}

export async function deriveVariant(bytes: Uint8Array, spec: ImageSpec): Promise<DerivedVariant> {
  let image = sharp(Buffer.from(bytes), { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  let width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error('image dimensions unknown');

  // 1. Aspect: crop the longer side toward the nearest allowed ratio.
  const aspect = width / height;
  let cropW = width;
  let cropH = height;
  if (spec.minAspect !== undefined && aspect < spec.minAspect) {
    cropH = Math.max(1, Math.floor(width / spec.minAspect));
  } else if (spec.maxAspect !== undefined && aspect > spec.maxAspect) {
    cropW = Math.max(1, Math.floor(height * spec.maxAspect));
  }
  if (cropW !== width || cropH !== height) {
    image = image.extract({
      left: Math.floor((width - cropW) / 2),
      top: Math.floor((height - cropH) / 2),
      width: cropW,
      height: cropH,
    });
    width = cropW;
  }

  // 2. Width bounds: shrink to maxWidth, enlarge to minWidth.
  if (spec.maxWidth && width > spec.maxWidth) {
    image = image.resize({ width: spec.maxWidth, withoutEnlargement: true });
  } else if (spec.minWidth && width < spec.minWidth) {
    image = image.resize({ width: spec.minWidth });
  }

  // 3. Output type.
  const mimeType = spec.outputMimeType ?? 'image/jpeg';
  image =
    mimeType === 'image/png'
      ? image.png({ compressionLevel: 9 })
      : image.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(data), mimeType, width: info.width, height: info.height };
}
