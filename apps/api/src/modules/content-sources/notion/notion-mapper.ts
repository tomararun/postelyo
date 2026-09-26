import { createHash } from 'node:crypto';
import type { BlockNode, CanonicalContent, InlineNode } from '../../posts/content.js';
import { asRecord, richTextToPlain, type NotionBlock, type NotionPage } from './notion-client.js';

/**
 * Notion page → source-agnostic `SourcePost`, and Notion blocks/rich text →
 * canonical content (domain-model §4). This is the only file that knows Notion
 * property names (via the contract → actual-name map from validation).
 */

export interface SourceMediaFile {
  name: string;
  url: string;
  /** `file` = Notion-hosted (expiring URL), `external` = user-provided link. */
  kind: 'file' | 'external';
}

export interface SourcePost {
  externalId: string;
  externalUrl: string;
  title: string;
  archived: boolean;
  lastEditedTime: string;
  sourceStatus: string | null;
  publishDate: { start: string; timeZone: string | null } | null;
  platforms: string[];
  /** The `Post Text` property; the page body is preferred when present. */
  postText: unknown;
  media: SourceMediaFile[];
  timeZone: string | null;
  /** Per-platform text overrides by provider id (Phase 2), plain text; empty ones omitted. */
  platformText: Record<string, string>;
  /** Current values of system-owned properties, used to patch only on change. */
  system: {
    postelyoStatus: string | null;
    postelyoNote: string;
    publishedUrl: string | null;
    publishedAt: string | null;
    postelyoId: string;
    /** Plain text of the optional `Published URLs` property (null when the column is absent). */
    publishedUrls: string | null;
  };
}

/** Notion property → provider id for the per-platform text overrides. */
export const PLATFORM_TEXT_PROPERTIES: Record<string, string> = {
  'LinkedIn Text': 'linkedin',
  'X Text': 'x',
  'Facebook Text': 'facebook',
  'Instagram Caption': 'instagram',
};

export type PropertyMap = Record<string, string>;

/** Actual property name for a contract name; falls back to the contract name itself. */
export function propName(map: PropertyMap, contractName: string): string {
  return map[contractName] ?? contractName;
}

export function mapPage(page: NotionPage, map: PropertyMap): SourcePost {
  const prop = (name: string) => page.properties[propName(map, name)] ?? {};
  const typeOf = (p: Record<string, unknown>) => (typeof p['type'] === 'string' ? p['type'] : '');

  const statusProp = prop('Status');
  // Status may be a `status` property (template duplicated by hand) or a `select` (API-created template).
  const status = asRecord(statusProp['status'] ?? statusProp['select']);
  const dateProp = asRecord(prop('Publish Date')['date']);
  const platformsRaw = prop('Platforms')['multi_select'];
  const mediaRaw = prop('Media')['files'];
  const tzProp = prop('Time Zone');
  const psStatus = asRecord(prop('Postelyo Status')['select']);

  const platformText: Record<string, string> = {};
  for (const [property, providerId] of Object.entries(PLATFORM_TEXT_PROPERTIES)) {
    const text = richTextToPlain(prop(property)['rich_text']).trim();
    if (text.length > 0) platformText[providerId] = text;
  }

  const media: SourceMediaFile[] = Array.isArray(mediaRaw)
    ? mediaRaw.flatMap((f) => {
        const r = asRecord(f);
        const kind = r['type'] === 'external' ? 'external' : 'file';
        const url = asRecord(r[kind])['url'];
        if (typeof url !== 'string' || url.length === 0) return [];
        return [{ name: typeof r['name'] === 'string' ? r['name'] : 'file', url, kind }];
      })
    : [];

  return {
    externalId: page.id,
    externalUrl: page.url,
    title: richTextToPlain(prop('Name')['title']) || 'Untitled',
    archived: page.archived,
    lastEditedTime: page.lastEditedTime,
    sourceStatus: typeof status['name'] === 'string' ? status['name'] : null,
    publishDate:
      typeof dateProp['start'] === 'string'
        ? {
            start: dateProp['start'],
            timeZone: typeof dateProp['time_zone'] === 'string' ? dateProp['time_zone'] : null,
          }
        : null,
    platforms: Array.isArray(platformsRaw)
      ? platformsRaw
          .map((o) => asRecord(o)['name'])
          .filter((n): n is string => typeof n === 'string')
      : [],
    postText: prop('Post Text')['rich_text'],
    media,
    timeZone:
      typeOf(tzProp) === 'select'
        ? ((asRecord(tzProp['select'])['name'] as string | undefined) ?? null)
        : richTextToPlain(tzProp['rich_text']) || null,
    platformText,
    system: {
      postelyoStatus: typeof psStatus['name'] === 'string' ? psStatus['name'] : null,
      postelyoNote: richTextToPlain(prop('Postelyo Note')['rich_text']),
      publishedUrl:
        typeof prop('Published URL')['url'] === 'string'
          ? (prop('Published URL')['url'] as string)
          : null,
      publishedAt: (asRecord(prop('Published At')['date'])['start'] as string | undefined) ?? null,
      postelyoId: richTextToPlain(prop('Postelyo ID')['rich_text']),
      publishedUrls: map['Published URLs']
        ? richTextToPlain(prop('Published URLs')['rich_text'])
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Content mapping
// ---------------------------------------------------------------------------

export interface MappedContent {
  content: CanonicalContent;
  hash: string;
  /** Non-fatal degradations (unsupported blocks etc.). */
  warnings: string[];
  plainLength: number;
}

const MAX_TEXT_CHARS = 20_000;

/** Rich text array → inline nodes. Links and bold/italic are preserved; other marks dropped. */
export function richTextToInlines(v: unknown): InlineNode[] {
  if (!Array.isArray(v)) return [];
  const out: InlineNode[] = [];
  for (const item of v) {
    const r = asRecord(item);
    const text = typeof r['plain_text'] === 'string' ? r['plain_text'] : '';
    if (text.length === 0) continue;
    const href = typeof r['href'] === 'string' ? r['href'] : null;
    if (href) {
      out.push({ t: 'link', text, href });
      continue;
    }
    if (r['type'] === 'mention') {
      out.push({ t: 'mention', text });
      continue;
    }
    const ann = asRecord(r['annotations']);
    const marks: Array<'bold' | 'italic'> = [];
    if (ann['bold'] === true) marks.push('bold');
    if (ann['italic'] === true) marks.push('italic');
    out.push(marks.length > 0 ? { t: 'text', text, marks } : { t: 'text', text });
  }
  return out;
}

/**
 * Page body blocks → canonical blocks. Consecutive list items collapse into one
 * list; headings, quotes and callouts degrade to paragraphs; anything else is
 * flattened to its text with a warning.
 */
export function blocksToCanonical(blocks: NotionBlock[]): {
  blocks: BlockNode[];
  warnings: string[];
} {
  const out: BlockNode[] = [];
  const warnings = new Set<string>();
  for (const b of blocks) {
    const inlines = richTextToInlines(b.value['rich_text']);
    switch (b.type) {
      case 'paragraph':
        if (inlines.length > 0) out.push({ type: 'paragraph', inlines });
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        if (inlines.length > 0) {
          out.push({
            type: 'paragraph',
            inlines: inlines.map((n) => (n.t === 'text' ? { ...n, marks: ['bold'] } : n)),
          });
        }
        break;
      case 'quote':
      case 'callout':
        if (inlines.length > 0) out.push({ type: 'paragraph', inlines });
        break;
      case 'bulleted_list_item':
      case 'numbered_list_item': {
        const type = b.type === 'bulleted_list_item' ? 'bulleted_list' : 'numbered_list';
        const last = out[out.length - 1];
        if (last && last.type === type) last.items.push(inlines);
        else out.push({ type, items: [inlines] });
        break;
      }
      case 'divider':
        break;
      default: {
        if (inlines.length > 0) {
          out.push({ type: 'paragraph', inlines });
          warnings.add(`Unsupported Notion block "${b.type}" was flattened to plain text.`);
        } else {
          warnings.add(`Unsupported Notion block "${b.type}" was skipped.`);
        }
      }
    }
    if (b.hasChildren && b.type !== 'bulleted_list_item' && b.type !== 'numbered_list_item') {
      warnings.add(`Nested content inside a "${b.type}" block was not included.`);
    }
  }
  return { blocks: out, warnings: [...warnings] };
}

export interface BuildContentInput {
  page: SourcePost;
  bodyBlocks: NotionBlock[];
  /** Media asset ids already allocated for `page.media`, same order. */
  mediaAssetIds: string[];
}

/** Body first; falls back to the `Post Text` property when the body is empty. */
export function buildCanonicalContent(input: BuildContentInput): MappedContent {
  const fromBody = blocksToCanonical(input.bodyBlocks);
  let blocks = fromBody.blocks;
  const warnings = [...fromBody.warnings];
  if (blocks.length === 0) {
    const inlines = richTextToInlines(input.page.postText);
    blocks = inlines.length > 0 ? splitParagraphs(inlines) : [];
  }

  const content: CanonicalContent = {
    v: 1,
    blocks,
    media: input.page.media.map((m, i) => ({
      assetId: input.mediaAssetIds[i] ?? '',
      kind: 'image',
      alt: m.name,
    })),
    ...(Object.keys(input.page.platformText ?? {}).length > 0
      ? { platformText: input.page.platformText }
      : {}),
    meta: { source: 'notion', sourcePageId: input.page.externalId },
  };
  const plainLength = blocks
    .flatMap((b) => (b.type === 'paragraph' ? b.inlines : b.items.flat()))
    .reduce((n, i) => n + i.text.length, 0);
  if (plainLength > MAX_TEXT_CHARS)
    warnings.push(`Content is very long (${plainLength} characters).`);

  return { content, hash: hashContent(content), warnings, plainLength };
}

/** A rich_text property has no block structure; blank lines separate paragraphs. */
function splitParagraphs(inlines: InlineNode[]): BlockNode[] {
  const paragraphs: InlineNode[][] = [[]];
  for (const node of inlines) {
    if (node.t !== 'text' || !node.text.includes('\n')) {
      paragraphs[paragraphs.length - 1]!.push(node);
      continue;
    }
    const parts = node.text.split(/\n{2,}/);
    parts.forEach((part, idx) => {
      if (idx > 0) paragraphs.push([]);
      if (part.length > 0) {
        const n: InlineNode = node.marks
          ? { t: 'text', text: part, marks: node.marks }
          : { t: 'text', text: part };
        paragraphs[paragraphs.length - 1]!.push(n);
      }
    });
  }
  return paragraphs.filter((p) => p.length > 0).map((inl) => ({ type: 'paragraph', inlines: inl }));
}

export function hashContent(content: CanonicalContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
