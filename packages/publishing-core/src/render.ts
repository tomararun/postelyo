import { createHash } from 'node:crypto';
import type { BlockNode, CanonicalContent, InlineNode } from './content.js';

/**
 * Shared rendering helpers for provider adapters. Adapters import from here
 * (inside the package) rather than reaching into the application.
 */

/**
 * Stable fingerprint of a post's text for reconciliation: whitespace-collapsed,
 * Unicode-normalised, sha256. Adapters apply it to the text a provider returns;
 * the reconciler applies it to what we rendered. Escaping differences between
 * the two sides are the adapter's responsibility (compare unescaped text).
 */
export function textFingerprint(text: string): string {
  const normalised = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised).digest('hex');
}

/** Plain text → paragraphs (blank lines separate them); links are left as text. */
export function plainTextToBlocks(text: string): BlockNode[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ type: 'paragraph', inlines: [{ t: 'text', text: p }] }));
}

/**
 * The content an adapter should render for `providerId`: the per-platform
 * text override when the author wrote one, otherwise the shared body. Media
 * and metadata are always shared.
 */
export function contentForProvider(
  content: CanonicalContent,
  providerId: string,
): CanonicalContent {
  const override = content.platformText?.[providerId];
  if (override === undefined || override.trim().length === 0) return content;
  return { ...content, blocks: plainTextToBlocks(override) };
}

/** Plain-text projection: paragraphs separated by blank lines, simple list markers. */
export function contentToPlainText(content: CanonicalContent): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => (n.t === 'link' ? (n.text === n.href ? n.href : `${n.text} ${n.href}`) : n.text))
      .join('');
  return content.blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return inline(b.inlines);
        case 'bulleted_list':
          return b.items.map((i) => `• ${inline(i)}`).join('\n');
        case 'numbered_list':
          return b.items.map((i, idx) => `${idx + 1}. ${inline(i)}`).join('\n');
      }
    })
    .join('\n\n');
}

/** Generic validation shared by adapters; providers add their own rules on top. */
export function validateAgainstCapabilities(
  content: { text: string; plainText?: string; media: { mimeType: string; byteSize: number }[] },
  caps: {
    maxTextLength: number;
    maxImages: number;
    supportedImageMimeTypes: readonly string[];
    maxImageBytes: number;
    imageRequired?: boolean;
  },
  opts: { providerName: string; length?: (text: string) => number } = { providerName: 'Provider' },
): { code: string; message: string }[] {
  const plain = content.plainText ?? content.text;
  const length = opts.length ? opts.length(plain) : plain.length;
  const issues: { code: string; message: string }[] = [];
  if (plain.trim().length === 0 && !(caps.imageRequired && content.media.length > 0)) {
    issues.push({ code: 'TEXT_EMPTY', message: 'Post text is empty.' });
  }
  if (length > caps.maxTextLength) {
    issues.push({
      code: 'TEXT_TOO_LONG',
      message: `Post text is ${length} characters; ${opts.providerName} allows ${caps.maxTextLength}.`,
    });
  }
  if (caps.imageRequired && content.media.length === 0) {
    issues.push({
      code: 'IMAGE_REQUIRED',
      message: `${opts.providerName} posts need an image; add one to the Media property.`,
    });
  }
  if (content.media.length > caps.maxImages) {
    issues.push({
      code: 'TOO_MANY_IMAGES',
      message: `${opts.providerName} posts from Postelyo support ${caps.maxImages} image(s); ${content.media.length} were attached.`,
    });
  }
  for (const m of content.media) {
    if (!caps.supportedImageMimeTypes.includes(m.mimeType)) {
      issues.push({
        code: 'UNSUPPORTED_IMAGE_TYPE',
        message: `Image type ${m.mimeType} is not supported by ${opts.providerName}.`,
      });
    }
    if (m.byteSize > caps.maxImageBytes) {
      issues.push({
        code: 'IMAGE_TOO_LARGE',
        message: `Image is ${(m.byteSize / (1024 * 1024)).toFixed(1)} MB; ${opts.providerName} allows ${Math.round(caps.maxImageBytes / (1024 * 1024))} MB.`,
      });
    }
  }
  return issues;
}
