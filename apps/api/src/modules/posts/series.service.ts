import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  type ContentSource,
  type Post,
  type Workspace,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { NotionClient, NotionDatabase } from '../content-sources/notion/notion-client.js';
import {
  blocksForWrite,
  buildCanonicalContent,
  mapPage,
  propName,
  richTextForWrite,
  type PropertyMap,
  type SourcePost,
} from '../content-sources/notion/notion-mapper.js';
import { richText } from '../content-sources/notion/notion-writeback.js';
import { wallClock, zonedTimeToUtc } from '../scheduling/schedule-time.js';
import { readSettings, DEFAULT_EVERGREEN_MIN_GAP_DAYS } from '../workspaces/settings.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { CanonicalContent } from './content.js';
import { PUBLICATION_WAITING } from './state-machine.js';

/**
 * Phase 4 recurring and evergreen posts. A source page with a `Repeat` rule
 * becomes a series: Postelyo creates real instance pages in the same Notion
 * database (linked through `Repeat Of`), so every instance is visible in the
 * calendar, editable, and publishes like any other page. Source edits reach
 * only future instances the user has not touched. Evergreen pages fill the
 * workspace's re-share slots, never repeating a page within the minimum gap.
 */

export type RepeatRule = 'weekly' | 'biweekly' | 'monthly' | 'evergreen';

/** Days ahead for which recurring instances exist. */
export const SERIES_HORIZON_DAYS = 60;
/** Days ahead for which evergreen slots are filled. */
export const EVERGREEN_LOOKAHEAD_DAYS = 14;
/** Instances due sooner than this are never rewritten by propagation. */
const PROPAGATION_FREEZE_MS = 5 * 60_000;

export function parseRepeatRule(v: string | null | undefined): RepeatRule | null {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'weekly' || s === 'every week') return 'weekly';
  if (s === 'every 2 weeks' || s === 'biweekly' || s === 'fortnightly') return 'biweekly';
  if (s === 'monthly' || s === 'every month') return 'monthly';
  if (s === 'evergreen') return 'evergreen';
  return null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;

/**
 * Occurrence dates after `start` (exclusive) up to `horizon` (inclusive) and
 * `until` (inclusive, YYYY-MM-DD). The time/offset suffix of `start` is kept so
 * instances publish at the same wall-clock time.
 */
export function occurrences(
  start: string,
  rule: Exclude<RepeatRule, 'evergreen'>,
  horizon: string,
  until: string | null,
  max = 12,
): string[] {
  const m = DATE_RE.exec(start);
  if (!m) return [];
  const [, y, mo, d, rest] = m;
  const base = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const out: string[] = [];
  for (let i = 1; i <= max; i++) {
    let next: Date;
    if (rule === 'monthly') {
      const targetMonth = base.getUTCMonth() + i;
      const yy = base.getUTCFullYear() + Math.floor(targetMonth / 12);
      const mm = targetMonth % 12;
      const lastDay = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      next = new Date(Date.UTC(yy, mm, Math.min(base.getUTCDate(), lastDay)));
    } else {
      next = new Date(base.getTime() + i * (rule === 'weekly' ? 7 : 14) * 86_400_000);
    }
    const date = next.toISOString().slice(0, 10);
    if (date > horizon) break;
    if (until && date > until) break;
    out.push(`${date}${rest ?? ''}`);
  }
  return out;
}

/** Text-only fingerprint used to tell edited instances from generated ones. */
export function seriesFingerprint(title: string, content: CanonicalContent): string {
  const text = content.blocks
    .map((b) =>
      b.type === 'paragraph'
        ? b.inlines.map((i) => i.text).join('')
        : b.items.map((it) => it.map((i) => i.text).join('')).join('\n'),
    )
    .join('\n\n');
  const overrides = Object.entries(content.platformText ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
  return createHash('sha256')
    .update(
      [title.trim(), text, overrides, content.firstComment ?? ''].join('\u0000').normalize('NFC'),
    )
    .digest('hex');
}

export interface SeriesRunResult {
  instancesCreated: number;
  instancesUpdated: number;
  evergreenFilled: number;
  warnings: string[];
}

export interface SeriesServiceDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

export class SeriesService {
  constructor(private readonly deps: SeriesServiceDeps) {}

  /** Runs inside the Notion sync for one source with an authenticated client. */
  async run(
    ctx: TenantContext,
    source: ContentSource,
    ws: Workspace,
    map: PropertyMap,
    client: NotionClient,
  ): Promise<SeriesRunResult> {
    const result: SeriesRunResult = {
      instancesCreated: 0,
      instancesUpdated: 0,
      evergreenFilled: 0,
      warnings: [],
    };
    if (!source.externalDatabaseId) return result;
    const sources = await this.deps.db
      .select()
      .from(post)
      .where(
        and(
          eq(post.contentSourceId, source.id),
          isNull(post.deletedAt),
          isNull(post.parentPostId),
          ne(post.repeatRule, 'evergreen'),
        ),
      );
    let schema: NotionDatabase | null = null;
    const schemaOf = async () =>
      (schema ??= await client.retrieveDatabase(source.externalDatabaseId!));

    for (const src of sources) {
      const rule = parseRepeatRule(src.repeatRule);
      if (!rule || rule === 'evergreen') continue;
      if (src.sourceStatus?.toLowerCase() !== 'scheduled' || !src.requestedPublishLocal) continue;
      try {
        await this.materialise(ctx, source, src, rule, map, client, schemaOf, result);
        await this.propagate(ctx, source, src, map, client, result);
      } catch (err) {
        const message = `series ${src.id}: ${(err as Error).message}`;
        result.warnings.push(message);
        this.deps.logger.warn({ err, postId: src.id }, 'series run failed for source page');
      }
    }
    try {
      await this.fillEvergreen(ctx, source, ws, map, client, schemaOf, result);
    } catch (err) {
      result.warnings.push(`evergreen: ${(err as Error).message}`);
      this.deps.logger.warn({ err, sourceId: source.id }, 'evergreen fill failed');
    }
    return result;
  }

  // ---------------------------------------------------------------------------

  private async materialise(
    ctx: TenantContext,
    source: ContentSource,
    src: Post,
    rule: Exclude<RepeatRule, 'evergreen'>,
    map: PropertyMap,
    client: NotionClient,
    schemaOf: () => Promise<NotionDatabase>,
    result: SeriesRunResult,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const horizon = new Date(now.getTime() + SERIES_HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dates = occurrences(src.requestedPublishLocal!, rule, horizon, src.repeatUntil);
    if (dates.length === 0) return;
    const keys = dates.map((d) => `${src.externalId}:${d.slice(0, 10)}`);
    const existing = await this.deps.db
      .select({ seriesKey: post.seriesKey })
      .from(post)
      .where(and(eq(post.contentSourceId, source.id), inArray(post.seriesKey, keys)));
    const have = new Set(existing.map((e) => e.seriesKey));
    const missing = dates.filter((d) => !have.has(`${src.externalId}:${d.slice(0, 10)}`));
    if (missing.length === 0) return;

    const page = mapPage(await client.retrievePage(src.externalId!), map);
    const blocks = await client.retrieveBlockChildren(src.externalId!);
    const children = blocksForWrite(blocks);
    const content = buildCanonicalContent({ page, bodyBlocks: blocks, mediaAssetIds: [] });
    const fp = seriesFingerprint(page.title, content.content);
    const schema = await schemaOf();
    const dropped = page.media.filter((m) => m.kind === 'file');
    if (dropped.length > 0) {
      result.warnings.push(
        `Series "${page.title}": ${dropped.length} Notion-hosted file(s) were not copied to instances; use an external image link.`,
      );
    }

    for (const date of missing) {
      const key = `${src.externalId}:${date.slice(0, 10)}`;
      const created = await client.createPage({
        parent: { database_id: source.externalDatabaseId },
        properties: instanceProperties(page, map, schema, {
          publishDate: { start: date, timeZone: page.publishDate?.timeZone ?? null },
          repeatOf: src.externalId!,
        }),
        ...(children.length > 0 ? { children } : {}),
      });
      const id = uuidv7();
      await this.deps.db.insert(post).values({
        id,
        workspaceId: ctx.workspaceId,
        contentSourceId: source.id,
        externalId: created.id,
        externalUrl: created.url || null,
        title: page.title,
        state: 'scheduled',
        sourceStatus: 'Scheduled',
        parentPostId: src.id,
        seriesKey: key,
        seriesFp: fp,
        requestedPlatforms: page.platforms,
        requestedPublishLocal: date,
      });
      await recordAudit(this.deps.db, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'post',
        entityId: id,
        event: 'series.instance_created',
        correlationId: ctx.correlationId,
        data: { sourcePostId: src.id, pageId: created.id, occurrence: date, rule },
      });
      result.instancesCreated += 1;
    }
    if (src.seriesSourceHash !== src.contentHash) {
      await this.deps.db
        .update(post)
        .set({ seriesSourceHash: src.contentHash, updatedAt: now })
        .where(eq(post.id, src.id));
    }
  }

  /** Source content changed: rewrite future, unedited instances. */
  private async propagate(
    ctx: TenantContext,
    source: ContentSource,
    src: Post,
    map: PropertyMap,
    client: NotionClient,
    result: SeriesRunResult,
  ): Promise<void> {
    if (!src.contentHash || src.seriesSourceHash === src.contentHash) return;
    const now = this.deps.clock.now();
    const instances = await this.deps.db
      .select()
      .from(post)
      .where(and(eq(post.parentPostId, src.id), isNull(post.deletedAt)));
    if (instances.length === 0) {
      await this.deps.db
        .update(post)
        .set({ seriesSourceHash: src.contentHash, updatedAt: now })
        .where(eq(post.id, src.id));
      return;
    }
    const page = mapPage(await client.retrievePage(src.externalId!), map);
    const blocks = await client.retrieveBlockChildren(src.externalId!);
    const children = blocksForWrite(blocks);
    const content = buildCanonicalContent({ page, bodyBlocks: blocks, mediaAssetIds: [] });
    const fp = seriesFingerprint(page.title, content.content);

    for (const inst of instances) {
      const pubs = await this.deps.db
        .select({ state: publication.state, scheduledAt: publication.scheduledAt })
        .from(publication)
        .where(eq(publication.postId, inst.id));
      const future =
        pubs.length === 0 ||
        pubs.every(
          (p) =>
            PUBLICATION_WAITING.includes(p.state) &&
            p.scheduledAt.getTime() - now.getTime() > PROPAGATION_FREEZE_MS,
        );
      if (!future) continue;
      if (inst.seriesFp === fp) continue;
      // Edited by a user since generation? Compare the instance's own snapshot with what we wrote.
      const instContent = (inst.content ?? {}) as Partial<CanonicalContent>;
      const own = inst.contentHash
        ? seriesFingerprint(inst.title, {
            v: 1,
            blocks: instContent.blocks ?? [],
            media: [],
            ...(instContent.platformText ? { platformText: instContent.platformText } : {}),
            ...(instContent.firstComment ? { firstComment: instContent.firstComment } : {}),
            meta: { source: 'notion' },
          })
        : inst.seriesFp;
      if (own !== inst.seriesFp) {
        result.warnings.push(
          `Instance "${inst.title}" was edited by hand; source changes not applied.`,
        );
        continue;
      }
      await client.updatePageProperties(inst.externalId!, instanceTextProperties(page, map));
      const old = await client.retrieveBlockChildren(inst.externalId!);
      for (const b of old) if (b.id) await client.deleteBlock(b.id);
      if (children.length > 0) await client.appendBlockChildren(inst.externalId!, children);
      await this.deps.db
        .update(post)
        .set({ seriesFp: fp, title: page.title, updatedAt: now })
        .where(eq(post.id, inst.id));
      await recordAudit(this.deps.db, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'post',
        entityId: inst.id,
        event: 'series.instance_updated',
        correlationId: ctx.correlationId,
        data: { sourcePostId: src.id, pageId: inst.externalId },
      });
      result.instancesUpdated += 1;
    }
    await this.deps.db
      .update(post)
      .set({ seriesSourceHash: src.contentHash, updatedAt: now })
      .where(eq(post.id, src.id));
  }

  // ---------------------------------------------------------------------------

  private async fillEvergreen(
    ctx: TenantContext,
    source: ContentSource,
    ws: Workspace,
    map: PropertyMap,
    client: NotionClient,
    schemaOf: () => Promise<NotionDatabase>,
    result: SeriesRunResult,
  ): Promise<void> {
    const settings = readSettings(ws).evergreen;
    if (!settings || settings.slots.length === 0) return;
    const pool = await this.deps.db
      .select()
      .from(post)
      .where(
        and(
          eq(post.contentSourceId, source.id),
          isNull(post.deletedAt),
          isNull(post.parentPostId),
          eq(post.repeatRule, 'evergreen'),
          eq(post.state, 'ready'),
        ),
      );
    if (pool.length === 0) return;
    const now = this.deps.clock.now();
    const gapMs = (settings.minGapDays ?? DEFAULT_EVERGREEN_MIN_GAP_DAYS) * 86_400_000;
    const slots = upcomingSlots(now, EVERGREEN_LOOKAHEAD_DAYS, settings.slots, ws.defaultTimezone);
    if (slots.length === 0) return;
    const keys = slots.map((s) => `evergreen:${s.toISOString()}`);
    const taken = new Set(
      (
        await this.deps.db
          .select({ seriesKey: post.seriesKey })
          .from(post)
          .where(and(eq(post.contentSourceId, source.id), inArray(post.seriesKey, keys)))
      ).map((r) => r.seriesKey),
    );
    // Last time each pool page was (or will be) shared.
    const lastShared = new Map<string, number>();
    const instances = await this.deps.db
      .select({
        parentPostId: post.parentPostId,
        local: post.requestedPublishLocal,
        created: post.createdAt,
      })
      .from(post)
      .where(
        and(
          inArray(
            post.parentPostId,
            pool.map((p) => p.id),
          ),
          isNull(post.deletedAt),
        ),
      );
    for (const i of instances) {
      const t = i.local ? Date.parse(i.local) : i.created.getTime();
      const prev = lastShared.get(i.parentPostId!) ?? 0;
      if (t > prev) lastShared.set(i.parentPostId!, t);
    }
    let schema: NotionDatabase | null = null;

    for (const slot of slots) {
      const key = `evergreen:${slot.toISOString()}`;
      if (taken.has(key)) continue;
      const candidate = pool
        .filter((p) => slot.getTime() - (lastShared.get(p.id) ?? 0) >= gapMs)
        .sort((a, b) => (lastShared.get(a.id) ?? 0) - (lastShared.get(b.id) ?? 0))[0];
      if (!candidate) continue;
      schema ??= await schemaOf();
      const page = mapPage(await client.retrievePage(candidate.externalId!), map);
      const blocks = await client.retrieveBlockChildren(candidate.externalId!);
      const children = blocksForWrite(blocks);
      const content = buildCanonicalContent({ page, bodyBlocks: blocks, mediaAssetIds: [] });
      const created = await client.createPage({
        parent: { database_id: source.externalDatabaseId },
        properties: instanceProperties(page, map, schema, {
          publishDate: { start: slot.toISOString(), timeZone: null },
          repeatOf: candidate.externalId!,
        }),
        ...(children.length > 0 ? { children } : {}),
      });
      const id = uuidv7();
      await this.deps.db.insert(post).values({
        id,
        workspaceId: ctx.workspaceId,
        contentSourceId: source.id,
        externalId: created.id,
        externalUrl: created.url || null,
        title: page.title,
        state: 'scheduled',
        sourceStatus: 'Scheduled',
        parentPostId: candidate.id,
        seriesKey: key,
        seriesFp: seriesFingerprint(page.title, content.content),
        requestedPlatforms: page.platforms,
        requestedPublishLocal: slot.toISOString(),
      });
      await recordAudit(this.deps.db, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'post',
        entityId: id,
        event: 'evergreen.slot_filled',
        correlationId: ctx.correlationId,
        data: { sourcePostId: candidate.id, pageId: created.id, slot: slot.toISOString() },
      });
      lastShared.set(candidate.id, slot.getTime());
      taken.add(key);
      result.evergreenFilled += 1;
    }
  }
}

/** Slot instants in [now, now + days] for the configured weekdays/times in `timeZone`. */
export function upcomingSlots(
  now: Date,
  days: number,
  slots: { weekday: number; time: string }[],
  timeZone: string,
): Date[] {
  const out: Date[] = [];
  const end = now.getTime() + days * 86_400_000;
  for (let i = 0; i <= days; i++) {
    const day = new Date(now.getTime() + i * 86_400_000);
    const w = wallClock(day, timeZone);
    // ISO weekday of that local date: 1 = Monday … 7 = Sunday.
    const jsDay = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
    const iso = jsDay === 0 ? 7 : jsDay;
    for (const s of slots) {
      if (s.weekday !== iso) continue;
      const [h, mi] = s.time.split(':').map(Number);
      const at = zonedTimeToUtc(w.year, w.month, w.day, h ?? 9, mi ?? 0, 0, timeZone);
      if (at.getTime() >= now.getTime() && at.getTime() <= end) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

// ---------------------------------------------------------------------------
// Instance page properties
// ---------------------------------------------------------------------------

function selectValue(schema: NotionDatabase, name: string, value: string): Record<string, unknown> {
  const type = Object.values(schema.properties).find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  )?.type;
  return type === 'status' ? { status: { name: value } } : { select: { name: value } };
}

/** Text-bearing properties copied from the source page (used for propagation too). */
export function instanceTextProperties(
  page: SourcePost,
  map: PropertyMap,
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [propName(map, 'Name')]: { title: richText(page.title) },
    [propName(map, 'Platforms')]: { multi_select: page.platforms.map((name) => ({ name })) },
  };
  const postText = richTextForWrite(page.postText);
  if (postText.length > 0) props[propName(map, 'Post Text')] = { rich_text: postText };
  for (const [providerId, text] of Object.entries(page.platformText)) {
    const property = Object.entries(PLATFORM_TEXT_BY_PROVIDER).find(
      ([, id]) => id === providerId,
    )?.[0];
    if (property && map[property]) props[map[property]] = { rich_text: richText(text) };
  }
  if (map['First Comment'])
    props[map['First Comment']] = { rich_text: richText(page.firstComment) };
  return props;
}

const PLATFORM_TEXT_BY_PROVIDER: Record<string, string> = {
  'LinkedIn Text': 'linkedin',
  'X Text': 'x',
  'Facebook Text': 'facebook',
  'Instagram Caption': 'instagram',
};

export function instanceProperties(
  page: SourcePost,
  map: PropertyMap,
  schema: NotionDatabase,
  opts: { publishDate: { start: string; timeZone: string | null }; repeatOf: string },
): Record<string, unknown> {
  const props = instanceTextProperties(page, map);
  props[propName(map, 'Status')] = selectValue(schema, propName(map, 'Status'), 'Scheduled');
  props[propName(map, 'Publish Date')] = {
    date: {
      start: opts.publishDate.start,
      ...(opts.publishDate.timeZone ? { time_zone: opts.publishDate.timeZone } : {}),
    },
  };
  const external = page.media.filter((m) => m.kind === 'external');
  if (external.length > 0) {
    props[propName(map, 'Media')] = {
      files: external.map((m) => ({ name: m.name, type: 'external', external: { url: m.url } })),
    };
  }
  if (page.timeZone && map['Time Zone']) {
    const tzType = Object.values(schema.properties).find((p) => p.name === map['Time Zone'])?.type;
    props[map['Time Zone']] =
      tzType === 'select'
        ? { select: { name: page.timeZone } }
        : { rich_text: richText(page.timeZone) };
  }
  if (map['Campaign'] && page.campaignIds.length > 0) {
    props[map['Campaign']] = { relation: page.campaignIds.map((id) => ({ id })) };
  }
  if (map['Repeat Of']) props[map['Repeat Of']] = { relation: [{ id: opts.repeatOf }] };
  return props;
}
