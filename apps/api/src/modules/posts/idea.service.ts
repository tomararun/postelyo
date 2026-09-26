import { eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { contentSource, post, type ContentSource } from '../../infra/db/schema.js';
import { uuidv7 } from '../../shared/ids.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import {
  asRecord,
  richTextToPlain,
  type NotionClient,
  type NotionDatabase,
  type NotionPage,
} from '../content-sources/notion/notion-client.js';
import {
  blocksForWrite,
  propName,
  type PropertyMap,
} from '../content-sources/notion/notion-mapper.js';
import { richText } from '../content-sources/notion/notion-writeback.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { workspace } from '../../infra/db/schema.js';
import type { AiService } from '../ai/ai.service.js';
import { draftPrompt, draftSystem } from '../ai/prompts.js';

/**
 * Phase 4 ideas: pages of the Ideas database whose `Status` is `Promote`
 * become `Draft` pages in the content database (title, notes and body
 * copied, platforms kept). The idea is then marked `Promoted` with a link to
 * the new page. Runs inside the Notion sync.
 */

interface IdeasConfig {
  ideasDatabaseId?: string | null;
  ideasPropertyMap?: PropertyMap;
  propertyMap?: PropertyMap;
}

interface IdeasCursor {
  ideasLastEditedAfter?: string;
}

export interface IdeaServiceDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Phase 6: `Status = Draft with AI` writes the draft body. */
  ai?: AiService;
}

export class IdeaService {
  constructor(private readonly deps: IdeaServiceDeps) {}

  async syncFromNotion(
    ctx: TenantContext,
    source: ContentSource,
    client: NotionClient,
  ): Promise<{ ideasSeen: number; promoted: number }> {
    const config = (source.config ?? {}) as IdeasConfig;
    const dbId = config.ideasDatabaseId;
    if (!dbId || !source.externalDatabaseId) return { ideasSeen: 0, promoted: 0 };
    const map: PropertyMap = config.ideasPropertyMap ?? {};
    const contentMap: PropertyMap = config.propertyMap ?? {};
    const cursor = (source.cursor ?? {}) as IdeasCursor;
    const since = cursor.ideasLastEditedAfter
      ? new Date(new Date(cursor.ideasLastEditedAfter).getTime() - 60_000).toISOString()
      : undefined;

    let seen = 0;
    let promoted = 0;
    let maxEdited = cursor.ideasLastEditedAfter ?? null;
    let contentSchema: NotionDatabase | null = null;
    let ideasSchema: NotionDatabase | null = null;
    let next: string | null = null;
    do {
      const list = await client.queryDatabase(dbId, { editedOnOrAfter: since, startCursor: next });
      for (const page of list.pages) {
        seen += 1;
        if (page.lastEditedTime && (!maxEdited || page.lastEditedTime > maxEdited))
          maxEdited = page.lastEditedTime;
        if (page.archived) continue;
        const prop = (name: string) => page.properties[propName(map, name)] ?? {};
        const statusProp = prop('Status');
        const status = asRecord(statusProp['select'] ?? statusProp['status']);
        const statusName = typeof status['name'] === 'string' ? status['name'].toLowerCase() : '';
        const withAi = statusName === 'draft with ai';
        if (statusName !== 'promote' && !withAi) continue;
        try {
          contentSchema ??= await client.retrieveDatabase(source.externalDatabaseId);
          ideasSchema ??= await client.retrieveDatabase(dbId);
          const url = await this.promote(
            ctx,
            source,
            page,
            map,
            contentMap,
            contentSchema,
            ideasSchema,
            client,
            withAi,
          );
          promoted += 1;
          this.deps.logger.info({ ideaId: page.id, url }, 'idea promoted');
        } catch (err) {
          this.deps.logger.warn({ err, ideaId: page.id }, 'idea promotion failed');
        }
      }
      next = list.hasMore ? list.nextCursor : null;
    } while (next && seen < 500);

    if (maxEdited && maxEdited !== cursor.ideasLastEditedAfter) {
      await this.deps.db
        .update(contentSource)
        .set({
          cursor: {
            ...(source.cursor as Record<string, unknown>),
            ideasLastEditedAfter: maxEdited,
          },
        })
        .where(eq(contentSource.id, source.id));
    }
    return { ideasSeen: seen, promoted };
  }

  private async promote(
    ctx: TenantContext,
    source: ContentSource,
    idea: NotionPage,
    map: PropertyMap,
    contentMap: PropertyMap,
    contentSchema: NotionDatabase,
    ideasSchema: NotionDatabase,
    client: NotionClient,
    withAi = false,
  ): Promise<string> {
    const prop = (name: string) => idea.properties[propName(map, name)] ?? {};
    const titleProp =
      Object.values(idea.properties).find((p) => p['type'] === 'title') ?? prop('Name');
    const title = richTextToPlain(titleProp['title']) || 'Untitled idea';
    const notes = richTextToPlain(prop('Notes')['rich_text']).trim();
    const platformsRaw = prop('Platforms')['multi_select'];
    const platforms = Array.isArray(platformsRaw)
      ? platformsRaw
          .map((o) => asRecord(o)['name'])
          .filter((n): n is string => typeof n === 'string')
      : [];
    const ideaBlocks = await client.retrieveBlockChildren(idea.id);
    const body = blocksForWrite(ideaBlocks);
    let children: unknown[] = [
      ...(notes.length > 0
        ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(notes) } }]
        : []),
      ...body,
    ];
    let aiNote = '';
    if (withAi) {
      // Phase 6: the AI writes the draft body from the idea; the idea text stays below it for reference.
      const [ws] = await this.deps.db
        .select()
        .from(workspace)
        .where(eq(workspace.id, ctx.workspaceId))
        .limit(1);
      if (!this.deps.ai || !ws) throw new Error('AI assistance is not available');
      const ideaText = ideaBlocks
        .map((b) => richTextToPlain(b.value['rich_text']))
        .filter((t) => t.length > 0)
        .join('\n\n');
      const { text } = await this.deps.ai.generate(ctx, ws, {
        purpose: 'draft_from_idea',
        system: draftSystem(),
        prompt: draftPrompt({ title, notes, body: ideaText, platforms }),
        effort: 'medium',
        maxTokens: 3000,
        entityType: 'idea',
        entityId: idea.id,
      });
      const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      children = [
        ...paragraphs.map((p) => ({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: richText(p) },
        })),
        { object: 'block', type: 'divider', divider: {} },
        {
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: richText('Original idea notes:') },
        },
        ...children,
      ];
      aiNote = 'Postelyo AI: draft written from the idea; review before scheduling.';
    }
    const statusType = (schema: NotionDatabase, name: string) =>
      Object.values(schema.properties).find((p) => p.name.toLowerCase() === name.toLowerCase())
        ?.type;
    const statusValue = (schema: NotionDatabase, name: string, value: string) =>
      statusType(schema, name) === 'status'
        ? { status: { name: value } }
        : { select: { name: value } };

    const created = await client.createPage({
      parent: { database_id: source.externalDatabaseId },
      properties: {
        [propName(contentMap, 'Name')]: { title: richText(title) },
        [propName(contentMap, 'Status')]: statusValue(
          contentSchema,
          propName(contentMap, 'Status'),
          'Draft',
        ),
        ...(platforms.length > 0
          ? {
              [propName(contentMap, 'Platforms')]: {
                multi_select: platforms.map((name) => ({ name })),
              },
            }
          : {}),
        ...(aiNote
          ? { [propName(contentMap, 'Postelyo Note')]: { rich_text: richText(aiNote) } }
          : {}),
      },
      ...(children.length > 0 ? { children } : {}),
    });
    if (withAi) {
      await this.deps.db
        .insert(post)
        .values({
          id: uuidv7(),
          workspaceId: ctx.workspaceId,
          contentSourceId: source.id,
          externalId: created.id,
          externalUrl: created.url || null,
          title,
          state: 'draft',
          sourceStatus: 'Draft',
          aiAssisted: true,
        })
        .onConflictDoNothing();
    }
    const patch: Record<string, unknown> = {
      [propName(map, 'Status')]: statusValue(ideasSchema, propName(map, 'Status'), 'Promoted'),
    };
    if (map['Post URL'] && created.url) patch[map['Post URL']] = { url: created.url };
    await client.updatePageProperties(idea.id, patch);
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'content_source',
      entityId: source.id,
      event: 'idea.promoted',
      correlationId: ctx.correlationId,
      data: { ideaPageId: idea.id, postPageId: created.id, title, withAi },
    });
    return created.url;
  }
}
