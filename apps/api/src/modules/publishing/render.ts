import { createHash } from 'node:crypto';
import type { CanonicalContent, InlineNode } from '../posts/content.js';

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

/**
 * Shared rendering helpers for provider adapters. Adapters import from here
 * (inside modules/publishing) rather than reaching into other modules.
 */

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
