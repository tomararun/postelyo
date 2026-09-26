import { and, eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { post, workspace, type ContentSource, type Workspace } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { AnalyticsQueryService } from '../analytics/analytics-query.service.js';
import { bestTimesText } from '../analytics/analytics-writeback.service.js';
import type { ContentSourceService } from '../content-sources/content-source.service.js';
import { NotionClient, type NotionDatabase } from '../content-sources/notion/notion-client.js';
import {
  PLATFORM_TEXT_PROPERTIES,
  buildCanonicalContent,
  mapPage,
  propName,
  type PropertyMap,
  type SourcePost,
} from '../content-sources/notion/notion-mapper.js';
import { richText } from '../content-sources/notion/notion-writeback.js';
import { contentToPlainText } from '@postelyo/publishing-core';
import { systemContext, type TenantContext } from '../tenancy/tenant-context.js';
import { AiError, type AiService } from './ai.service.js';
import {
  PLATFORM_LIMITS,
  extractJson,
  repurposePrompt,
  repurposeSystem,
  variantsPrompt,
  variantsSystem,
  type RepurposeKind,
} from './prompts.js';

/**
 * Phase 6 Notion-triggered assistance, run inside the sync after the page
 * loop: `Generate variants` fills empty per-platform text fields; `Repurpose`
 * creates linked Draft pages. Human text is never overwritten, every outcome
 * lands in the note as a `Postelyo AI` line, and the trigger is reset so a
 * request runs once.
 */

/** A Notion `Platforms` option → provider id (Phase 2 mapping, reduced to what AI adapts). */
const PLATFORM_TO_PROVIDER: Record<string, string> = {
  linkedin: 'linkedin',
  'linkedin page': 'linkedin',
  x: 'x',
  twitter: 'x',
  facebook: 'facebook',
  'facebook page': 'facebook',
  instagram: 'instagram',
};

const PROVIDER_TO_PROPERTY: Record<string, string> = Object.fromEntries(
  Object.entries(PLATFORM_TEXT_PROPERTIES).map(([property, provider]) => [provider, property]),
);

const REPURPOSE_KINDS: Record<string, RepurposeKind> = {
  thread: 'thread',
  'short variants': 'short_variants',
  'carousel outline': 'carousel_outline',
};

export interface AiTrigger {
  page: SourcePost;
  pageId: string;
}

export interface AiCompanionDeps {
  db: Db;
  ai: AiService;
  contentSources: ContentSourceService;
  analytics?: AnalyticsQueryService;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class AiCompanionService {
  constructor(private readonly deps: AiCompanionDeps) {}

  /** Handles every page flagged during this sync run. Never throws for AI problems. */
  async run(
    ctx: TenantContext,
    source: ContentSource,
    ws: Workspace,
    map: PropertyMap,
    client: NotionClient,
    triggers: AiTrigger[],
  ): Promise<{ variants: number; repurposed: number; warnings: string[] }> {
    const result = { variants: 0, repurposed: 0, warnings: [] as string[] };
    if (triggers.length === 0) return result;
    let schema: NotionDatabase | null = null;
    const schemaOf = async () =>
      (schema ??= await client.retrieveDatabase(source.externalDatabaseId!));
    for (const t of triggers) {
      if (t.page.generateVariants) {
        try {
          const n = await this.variantsFor(ctx, source, ws, map, client, t);
          result.variants += n;
        } catch (err) {
          result.warnings.push(`variants for "${t.page.title}": ${(err as Error).message}`);
          await this.note(
            client,
            map,
            t,
            `Postelyo AI: could not generate variants (${(err as Error).message})`,
            {
              [propName(map, 'Generate variants')]: { checkbox: false },
            },
          ).catch(() => undefined);
        }
      }
      if (t.page.repurpose) {
        try {
          const n = await this.repurposeFor(ctx, source, ws, map, client, t, await schemaOf());
          result.repurposed += n;
        } catch (err) {
          result.warnings.push(`repurpose for "${t.page.title}": ${(err as Error).message}`);
          await this.note(
            client,
            map,
            t,
            `Postelyo AI: could not repurpose (${(err as Error).message})`,
            {
              [propName(map, 'Repurpose')]: { select: null },
            },
          ).catch(() => undefined);
        }
      }
    }
    return result;
  }

  /** Dashboard trigger: same path as the checkbox, for one post. */
  async variantsForPost(ctx: TenantContext, postId: string): Promise<number> {
    const [row] = await this.deps.db
      .select()
      .from(post)
      .where(and(eq(post.id, postId), eq(post.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!row?.contentSourceId || !row.externalId)
      throw new AiError('disabled', 'This post is not linked to Notion.');
    const source = await this.deps.contentSources.get(ctx, row.contentSourceId);
    if (!source?.externalDatabaseId)
      throw new AiError('disabled', 'The Notion source is not active.');
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!ws) throw new AiError('disabled', 'workspace missing');
    const map = (source.config as { propertyMap?: PropertyMap }).propertyMap ?? {};
    return this.deps.contentSources.withToken(ctx, source.id, 'sync', async (token) => {
      const client = new NotionClient(
        token,
        this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      );
      const page = mapPage(await client.retrievePage(row.externalId!), map);
      return this.variantsFor(ctx, source, ws, map, client, { page, pageId: row.externalId! });
    });
  }

  private async sourceText(client: NotionClient, t: AiTrigger): Promise<string> {
    const blocks = await client.retrieveBlockChildren(t.pageId);
    const mapped = buildCanonicalContent({ page: t.page, bodyBlocks: blocks, mediaAssetIds: [] });
    return contentToPlainText(mapped.content).trim();
  }

  private async variantsFor(
    ctx: TenantContext,
    source: ContentSource,
    ws: Workspace,
    map: PropertyMap,
    client: NotionClient,
    t: AiTrigger,
  ): Promise<number> {
    const text = await this.sourceText(client, t);
    if (text.length === 0) throw new AiError('guardrail', 'the page body is empty');
    // Only platforms the page targets, only fields the author left empty.
    const providers = [
      ...new Set(
        t.page.platforms
          .map((p) => PLATFORM_TO_PROVIDER[p.split(':')[0]!.trim().toLowerCase()])
          .filter((p): p is string => Boolean(p)),
      ),
    ];
    const wanted = providers.filter((p) => !(t.page.platformText[p] ?? '').trim());
    const skipped = providers.filter((p) => (t.page.platformText[p] ?? '').trim().length > 0);
    if (wanted.length === 0) {
      await this.note(
        client,
        map,
        t,
        `Postelyo AI: every platform text already has your own words; nothing generated.`,
        {
          [propName(map, 'Generate variants')]: { checkbox: false },
        },
      );
      return 0;
    }
    const insights = await this.insights(ctx.workspaceId, ws);
    const { text: out } = await this.deps.ai.generate(ctx, ws, {
      purpose: 'variants',
      system: variantsSystem(),
      prompt: variantsPrompt({
        title: t.page.title,
        sourceText: text,
        platforms: wanted,
        hashtags: insights.hashtags,
        bestTimes: insights.bestTimes,
      }),
      effort: 'medium',
      maxTokens: 4000,
      json: true,
      entityType: 'post',
      entityId: t.pageId,
    });
    const parsed = extractJson<Record<string, unknown>>(out);
    if (!parsed) throw new AiError('provider', 'the model did not return the expected JSON');
    const props: Record<string, unknown> = {
      [propName(map, 'Generate variants')]: { checkbox: false },
    };
    const written: string[] = [];
    for (const p of wanted) {
      const v = parsed[p];
      const property = PROVIDER_TO_PROPERTY[p];
      if (typeof v !== 'string' || v.trim().length === 0 || !property || !map[property]) continue;
      const limit = PLATFORM_LIMITS[p]?.maxChars ?? 2000;
      props[map[property]] = { rich_text: richText(v.trim().slice(0, limit)) };
      written.push(PLATFORM_LIMITS[p]?.name ?? p);
    }
    const lines = [
      written.length > 0
        ? `Postelyo AI: suggested ${written.join(', ')} text; edit freely, it publishes only when you set Scheduled.`
        : 'Postelyo AI: no usable variant came back.',
      skipped.length > 0
        ? `Kept your own text for ${skipped.map((p) => PLATFORM_LIMITS[p]?.name ?? p).join(', ')}.`
        : '',
      insights.hashtags.length > 0
        ? `Suggested hashtags: ${insights.hashtags.map((h) => `#${h}`).join(' ')}.`
        : '',
      insights.bestTimes ? `Best times: ${insights.bestTimes}` : '',
    ].filter((l) => l.length > 0);
    await this.note(client, map, t, lines.join(' '), props);
    await this.markAssisted(ctx, source, t.pageId, 'variants', written);
    return written.length;
  }

  private async repurposeFor(
    ctx: TenantContext,
    source: ContentSource,
    ws: Workspace,
    map: PropertyMap,
    client: NotionClient,
    t: AiTrigger,
    schema: NotionDatabase,
  ): Promise<number> {
    const kind = REPURPOSE_KINDS[(t.page.repurpose ?? '').trim().toLowerCase()];
    if (!kind) throw new AiError('guardrail', `unknown repurpose option "${t.page.repurpose}"`);
    const text = await this.sourceText(client, t);
    if (text.length === 0) throw new AiError('guardrail', 'the page body is empty');
    const { text: out } = await this.deps.ai.generate(ctx, ws, {
      purpose: 'repurpose',
      system: repurposeSystem(),
      prompt: repurposePrompt({ title: t.page.title, sourceText: text, kind }),
      effort: 'medium',
      maxTokens: 6000,
      json: true,
      entityType: 'post',
      entityId: t.pageId,
    });
    const items = extractJson<{ title?: unknown; body?: unknown }[]>(out);
    if (!Array.isArray(items) || items.length === 0)
      throw new AiError('provider', 'the model did not return the expected JSON array');
    const statusType = Object.values(schema.properties).find(
      (p) => p.name.toLowerCase() === propName(map, 'Status').toLowerCase(),
    )?.type;
    const statusValue =
      statusType === 'status' ? { status: { name: 'Draft' } } : { select: { name: 'Draft' } };
    const label =
      kind === 'thread' ? 'Thread' : kind === 'short_variants' ? 'Short variant' : 'Slide';
    let created = 0;
    if (kind === 'thread' || kind === 'carousel_outline') {
      // One page holding the whole sequence keeps a thread together.
      const children = items.map((it, i) => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: richText(
            `${label} ${i + 1}${typeof it.title === 'string' && it.title ? ` · ${it.title}` : ''}: ${typeof it.body === 'string' ? it.body : ''}`,
          ),
        },
      }));
      await client.createPage({
        parent: { database_id: source.externalDatabaseId },
        properties: {
          [propName(map, 'Name')]: {
            title: richText(
              `${t.page.title} · ${label === 'Slide' ? 'carousel outline' : 'thread'}`,
            ),
          },
          [propName(map, 'Status')]: statusValue,
          ...(t.page.platforms.length > 0
            ? {
                [propName(map, 'Platforms')]: {
                  multi_select: t.page.platforms.map((name) => ({ name })),
                },
              }
            : {}),
          ...(map['Repeat Of'] ? { [map['Repeat Of']]: { relation: [{ id: t.pageId }] } } : {}),
        },
        children,
      });
      created = 1;
    } else {
      for (const [i, it] of items.entries()) {
        const body = typeof it.body === 'string' ? it.body : '';
        if (!body) continue;
        await client.createPage({
          parent: { database_id: source.externalDatabaseId },
          properties: {
            [propName(map, 'Name')]: {
              title: richText(
                typeof it.title === 'string' && it.title
                  ? it.title
                  : `${t.page.title} · variant ${i + 1}`,
              ),
            },
            [propName(map, 'Status')]: statusValue,
            ...(t.page.platforms.length > 0
              ? {
                  [propName(map, 'Platforms')]: {
                    multi_select: t.page.platforms.map((name) => ({ name })),
                  },
                }
              : {}),
            ...(map['Repeat Of'] ? { [map['Repeat Of']]: { relation: [{ id: t.pageId }] } } : {}),
          },
          children: [
            { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(body) } },
          ],
        });
        created += 1;
      }
    }
    await this.note(
      client,
      map,
      t,
      `Postelyo AI: created ${created} draft page(s) (${kind.replace('_', ' ')}) linked through Repeat Of; review before scheduling.`,
      { [propName(map, 'Repurpose')]: { select: null } },
    );
    await this.markAssisted(ctx, source, t.pageId, 'repurpose', [kind]);
    return created;
  }

  private async insights(
    workspaceId: string,
    ws: Workspace,
  ): Promise<{ hashtags: string[]; bestTimes: string | null }> {
    if (!this.deps.analytics) return { hashtags: [], bestTimes: null };
    try {
      const s = await this.deps.analytics.summary(workspaceId, ws.defaultTimezone, 12);
      return {
        hashtags: s.hashtags.slice(0, 5).map((h) => h.hashtag),
        bestTimes: s.bestTimes.basis === 'history' ? bestTimesText(s.bestTimes) : null,
      };
    } catch {
      return { hashtags: [], bestTimes: null };
    }
  }

  /** Appends a `Postelyo AI` line to the note (keeps whatever the sync wrote) and applies extra properties. */
  private async note(
    client: NotionClient,
    map: PropertyMap,
    t: AiTrigger,
    line: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const current = t.page.system.postelyoNote
      .split('\n')
      .filter((l) => !l.startsWith('Postelyo AI:'));
    const note = [...current, line].filter((l) => l.trim().length > 0).join('\n');
    await client.updatePageProperties(t.pageId, {
      ...extra,
      [propName(map, 'Postelyo Note')]: { rich_text: richText(note) },
    });
  }

  private async markAssisted(
    ctx: TenantContext,
    source: ContentSource,
    pageId: string,
    kind: string,
    details: string[],
  ): Promise<void> {
    const [row] = await this.deps.db
      .update(post)
      .set({ aiAssisted: true, updatedAt: this.deps.clock.now() })
      .where(and(eq(post.contentSourceId, source.id), eq(post.externalId, pageId)))
      .returning({ id: post.id });
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'post',
      entityId: row?.id ?? pageId,
      event: 'ai.assisted',
      correlationId: ctx.correlationId,
      data: { kind, details, pageId },
    });
  }
}

export function companionContext(workspaceId: string, correlationId: string): TenantContext {
  return systemContext(workspaceId, 'ai', correlationId);
}
