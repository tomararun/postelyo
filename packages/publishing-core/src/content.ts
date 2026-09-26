/**
 * Canonical, source-agnostic content format (domain-model §4). Content sources
 * (Notion, later the native editor) produce it; publishing providers render it.
 * Closed type sets: unknown source blocks are degraded to text at ingestion.
 */

export type InlineNode =
  | { t: 'text'; text: string; marks?: Array<'bold' | 'italic'> }
  | { t: 'link'; text: string; href: string }
  | { t: 'mention'; text: string; ref?: string }
  | { t: 'hashtag'; text: string };

export type BlockNode =
  | { type: 'paragraph'; inlines: InlineNode[] }
  | { type: 'bulleted_list'; items: InlineNode[][] }
  | { type: 'numbered_list'; items: InlineNode[][] };

export interface MediaRef {
  assetId: string;
  kind: 'image';
  alt?: string;
}

export interface CanonicalContent {
  v: 1;
  blocks: BlockNode[];
  media: MediaRef[];
  /**
   * Per-platform plain-text overrides keyed by provider id (Phase 2). When
   * present for a provider, adapters render this text instead of `blocks`;
   * media and everything else stay shared. Blank lines separate paragraphs.
   */
  platformText?: Record<string, string>;
  meta: { source: 'notion' | 'native'; sourcePageId?: string };
}

/** The immutable snapshot a publication is rendered from. */
export interface PostSnapshot {
  postId: string;
  workspaceId: string;
  title: string;
  content: CanonicalContent;
  contentHash: string;
}
