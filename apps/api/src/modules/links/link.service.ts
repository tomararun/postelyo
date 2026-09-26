import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../../infra/db/client.js';
import { shortLink, type ShortLink } from '../../infra/db/schema.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import type { BlockNode, CanonicalContent, InlineNode } from '../posts/content.js';
import type { LinkSettings } from '../workspaces/settings.js';

/**
 * Phase 4 link handling. UTM parameters and short links are applied to the
 * rendered content of a publication at publish time; the Notion source is
 * never rewritten. Short codes are stable per (publication, target) so a
 * retried publish reuses them.
 */

export interface LinkPolicyContext {
  workspaceId: string;
  publicationId: string;
  /** Provider id, for `{platform}` in the UTM campaign template. */
  platform: string;
  /** Campaign name, for `{campaign}`; empty when the post has none. */
  campaignName: string | null;
}

export interface AppliedLinks {
  content: CanonicalContent;
  /** Every rewritten link: what the reader sees → where it goes. */
  links: { shown: string; target: string; code: string | null }[];
}

const URL_RE = /https?:\/\/[^\s<>()"']+/g;
const SHORT_CODE_BYTES = 6;

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 60);
}

/** Adds UTM parameters unless the URL already carries any `utm_*` parameter. */
export function withUtm(
  url: string,
  utm: NonNullable<LinkSettings['utm']>,
  ctx: Pick<LinkPolicyContext, 'platform' | 'campaignName'>,
): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
  for (const k of u.searchParams.keys()) if (k.startsWith('utm_')) return url;
  const fill = (v: string) =>
    v
      .replace(/\{campaign\}/g, ctx.campaignName ? slugify(ctx.campaignName) : '')
      .replace(/\{platform\}/g, ctx.platform)
      .replace(/^-+|-+$/g, '');
  if (utm.source) u.searchParams.set('utm_source', fill(utm.source));
  if (utm.medium) u.searchParams.set('utm_medium', fill(utm.medium));
  if (utm.campaign) {
    const c = fill(utm.campaign);
    if (c.length > 0) u.searchParams.set('utm_campaign', c);
  }
  return u.toString();
}

export interface LinkServiceDeps {
  db: Db;
  clock: Clock;
  appBaseUrl: string;
}

export class LinkService {
  constructor(private readonly deps: LinkServiceDeps) {}

  shortUrl(code: string): string {
    return `${this.deps.appBaseUrl.replace(/\/$/, '')}/l/${code}`;
  }

  /**
   * Rewrites every link in `content` (link nodes and bare URLs in text) per the
   * workspace policy. Returns the content unchanged when no policy applies.
   */
  async apply(
    content: CanonicalContent,
    settings: LinkSettings | undefined,
    ctx: LinkPolicyContext,
  ): Promise<AppliedLinks> {
    const utm = settings?.utm;
    const shorten = settings?.shorten === true;
    if (!utm && !shorten) return { content, links: [] };

    const links: AppliedLinks['links'] = [];
    const cache = new Map<string, { shown: string; code: string | null }>();
    const rewrite = async (original: string): Promise<string> => {
      const hit = cache.get(original);
      if (hit) return hit.shown;
      const target = utm ? withUtm(original, utm, ctx) : original;
      let shown = target;
      let code: string | null = null;
      if (shorten && /^https?:\/\//.test(target)) {
        code = await this.codeFor(ctx, target);
        shown = this.shortUrl(code);
      }
      cache.set(original, { shown, code });
      if (shown !== original || target !== original) links.push({ shown, target, code });
      return shown;
    };

    const mapInline = async (nodes: InlineNode[]): Promise<InlineNode[]> => {
      const out: InlineNode[] = [];
      for (const n of nodes) {
        if (n.t === 'link') {
          const href = await rewrite(n.href);
          // A link whose visible text is the URL shows the new URL too.
          out.push({ t: 'link', text: n.text === n.href ? href : n.text, href });
          continue;
        }
        if (n.t === 'text' && URL_RE.test(n.text)) {
          URL_RE.lastIndex = 0;
          const parts: InlineNode[] = [];
          let last = 0;
          for (const m of n.text.matchAll(URL_RE)) {
            const idx = m.index ?? 0;
            if (idx > last) parts.push({ ...n, text: n.text.slice(last, idx) });
            const shown = await rewrite(m[0]);
            parts.push({ ...n, text: shown });
            last = idx + m[0].length;
          }
          if (last < n.text.length) parts.push({ ...n, text: n.text.slice(last) });
          out.push(...parts);
          continue;
        }
        URL_RE.lastIndex = 0;
        out.push(n);
      }
      return out;
    };

    const blocks: BlockNode[] = [];
    for (const b of content.blocks) {
      if (b.type === 'paragraph')
        blocks.push({ type: 'paragraph', inlines: await mapInline(b.inlines) });
      else {
        const items: InlineNode[][] = [];
        for (const item of b.items) items.push(await mapInline(item));
        blocks.push({ type: b.type, items });
      }
    }
    let platformText: Record<string, string> | undefined;
    if (content.platformText) {
      platformText = {};
      for (const [k, v] of Object.entries(content.platformText)) {
        platformText[k] = await rewriteText(v, rewrite);
      }
    }
    return {
      content: { ...content, blocks, ...(platformText ? { platformText } : {}) },
      links,
    };
  }

  /** Stable code for (publication, target); creates the row on first use. */
  private async codeFor(ctx: LinkPolicyContext, target: string): Promise<string> {
    const [existing] = await this.deps.db
      .select({ code: shortLink.code })
      .from(shortLink)
      .where(and(eq(shortLink.publicationId, ctx.publicationId), eq(shortLink.targetUrl, target)))
      .limit(1);
    if (existing) return existing.code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomBytes(SHORT_CODE_BYTES).toString('base64url');
      const inserted = await this.deps.db
        .insert(shortLink)
        .values({
          id: uuidv7(),
          workspaceId: ctx.workspaceId,
          publicationId: ctx.publicationId,
          code,
          targetUrl: target,
        })
        .onConflictDoNothing()
        .returning({ code: shortLink.code });
      if (inserted.length > 0) return inserted[0]!.code;
      // Either the code collided or a concurrent publish inserted the same target.
      const [again] = await this.deps.db
        .select({ code: shortLink.code })
        .from(shortLink)
        .where(and(eq(shortLink.publicationId, ctx.publicationId), eq(shortLink.targetUrl, target)))
        .limit(1);
      if (again) return again.code;
    }
    throw new Error('could not allocate a short link code');
  }

  /** Redirect target for `/l/:code`; counts the click. Null when unknown. */
  async resolve(code: string): Promise<string | null> {
    const now = this.deps.clock.now();
    const [row] = await this.deps.db
      .update(shortLink)
      .set({ clicks: sql`${shortLink.clicks} + 1`, lastClickAt: now, updatedAt: now })
      .where(eq(shortLink.code, code))
      .returning({ targetUrl: shortLink.targetUrl });
    return row?.targetUrl ?? null;
  }

  async forPublication(publicationId: string): Promise<ShortLink[]> {
    return this.deps.db
      .select()
      .from(shortLink)
      .where(eq(shortLink.publicationId, publicationId))
      .orderBy(shortLink.createdAt);
  }
}

async function rewriteText(
  text: string,
  rewrite: (url: string) => Promise<string>,
): Promise<string> {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    out += text.slice(last, idx) + (await rewrite(m[0]));
    last = idx + m[0].length;
  }
  return out + text.slice(last);
}
