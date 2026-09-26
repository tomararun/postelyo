import { and, eq, isNull, ne, notInArray } from 'drizzle-orm';
import type { Db } from '../../../infra/db/client.js';
import {
  contentSource,
  post,
  socialAccount,
  workspace,
  type ContentSource,
} from '../../../infra/db/schema.js';
import type { Logger } from '../../../infra/logger.js';
import type { Clock } from '../../../shared/clock.js';
import { recordAudit } from '../../audit/audit.js';
import type { PostIngestService, IngestAction } from '../../posts/post-ingest.service.js';
import { systemContext, type TenantContext } from '../../tenancy/tenant-context.js';
import type { ContentSourceService } from '../content-source.service.js';
import { NotionApiError, NotionClient, type NotionPage } from './notion-client.js';
import { mapPage, type PropertyMap } from './notion-mapper.js';
import { writebackPatch } from './notion-writeback.js';
import type { CampaignService } from '../../campaigns/campaign.service.js';
import type { IdeaService } from '../../posts/idea.service.js';
import type { SeriesService } from '../../posts/series.service.js';

export interface SyncSummary {
  sourceId: string;
  workspaceId: string;
  pagesSeen: number;
  actions: Record<IngestAction, number>;
  writebacks: number;
  errors: string[];
  cursor: string | null;
  /** Phase 4 companions (campaigns, series, evergreen, ideas), when enabled. */
  extras?: {
    campaignsSeen: number;
    summariesWritten: number;
    instancesCreated: number;
    instancesUpdated: number;
    evergreenFilled: number;
    ideasSeen: number;
    promoted: number;
    warnings: string[];
  };
}

interface SyncCursor {
  lastEditedAfter?: string;
}

export interface NotionSyncDeps {
  db: Db;
  contentSources: ContentSourceService;
  ingest: PostIngestService;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** Phase 4 */
  campaigns?: CampaignService;
  series?: SeriesService;
  ideas?: IdeaService;
}

function emptySummary(sourceId: string, workspaceId: string): SyncSummary {
  return {
    sourceId,
    workspaceId,
    pagesSeen: 0,
    actions: {
      archived: 0,
      mirrored: 0,
      awaiting_schedule: 0,
      validation_error: 0,
      scheduled: 0,
      cancelled: 0,
    },
    writebacks: 0,
    errors: [],
    cursor: null,
  };
}

/** Re-read pages edited within this window before the cursor to absorb clock skew and same-second edits. */
const CURSOR_OVERLAP_MS = 60_000;
/** Safety cap per run per source; the next tick continues from the cursor. */
const MAX_PAGES_PER_RUN = 500;

/**
 * Incremental Notion → Postelyo sync (architecture §2.3 step 2, §11.1).
 * Polling is the source of truth; webhooks may later shorten the latency but
 * never replace this loop.
 */
export class NotionSyncService {
  constructor(private readonly deps: NotionSyncDeps) {}

  async syncAllActive(correlationId: string): Promise<SyncSummary[]> {
    const sources = await this.deps.db
      .select({ id: contentSource.id, workspaceId: contentSource.workspaceId })
      .from(contentSource)
      .where(
        and(
          eq(contentSource.kind, 'notion'),
          eq(contentSource.status, 'active'),
          isNull(contentSource.disconnectedAt),
        ),
      );
    const out: SyncSummary[] = [];
    for (const s of sources) {
      try {
        out.push(await this.syncSource(s.workspaceId, s.id, `${correlationId}:${s.id}`));
      } catch (err) {
        this.deps.logger.error({ err, sourceId: s.id }, 'notion sync crashed for source');
      }
    }
    return out;
  }

  /**
   * Webhook-triggered sync of one page (architecture §11.1). Same ingest path as
   * the polling loop; the cursor is not moved, so polling still re-reads the page.
   */
  async syncPage(
    workspaceId: string,
    sourceId: string,
    pageId: string,
    correlationId: string,
  ): Promise<SyncSummary> {
    const ctx = systemContext(workspaceId, 'notion-sync-page', correlationId);
    const summary = emptySummary(sourceId, workspaceId);
    const source = await this.deps.contentSources.get(ctx, sourceId);
    if (
      !source ||
      source.kind !== 'notion' ||
      source.disconnectedAt ||
      source.status !== 'active' ||
      !source.externalDatabaseId
    ) {
      summary.errors.push('source not active');
      return summary;
    }
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws) {
      summary.errors.push('workspace missing');
      return summary;
    }
    const accounts = await this.deps.db
      .select()
      .from(socialAccount)
      .where(and(eq(socialAccount.workspaceId, workspaceId), isNull(socialAccount.disconnectedAt)));
    const map: PropertyMap = (source.config as { propertyMap?: PropertyMap }).propertyMap ?? {};

    await this.deps.contentSources.withToken(ctx, sourceId, 'sync', async (token) => {
      const client = new NotionClient(
        token,
        this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
      );
      let page: NotionPage;
      try {
        page = await client.retrievePage(pageId);
      } catch (err) {
        if (err instanceof NotionApiError && err.code === 'not_found') {
          page = { id: pageId, url: '', archived: true, lastEditedTime: '', properties: {} };
        } else {
          throw err;
        }
      }
      summary.pagesSeen += 1;
      await this.processPage(ctx, source, ws, accounts, map, client, page, summary);
    });
    return summary;
  }

  async syncSource(
    workspaceId: string,
    sourceId: string,
    correlationId: string,
  ): Promise<SyncSummary> {
    const ctx = systemContext(workspaceId, 'notion-sync', correlationId);
    const source = await this.deps.contentSources.get(ctx, sourceId);
    const summary = emptySummary(sourceId, workspaceId);
    if (
      !source ||
      source.kind !== 'notion' ||
      source.disconnectedAt ||
      !source.externalDatabaseId
    ) {
      summary.errors.push('source not active');
      return summary;
    }

    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws) {
      summary.errors.push('workspace missing');
      return summary;
    }
    const accounts = await this.deps.db
      .select()
      .from(socialAccount)
      .where(and(eq(socialAccount.workspaceId, workspaceId), isNull(socialAccount.disconnectedAt)));

    const config = source.config as { propertyMap?: PropertyMap };
    const map: PropertyMap = config.propertyMap ?? {};
    const cursor = (source.cursor ?? {}) as SyncCursor;

    try {
      await this.deps.contentSources.withToken(ctx, sourceId, 'sync', async (token) => {
        const client = new NotionClient(
          token,
          this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {},
        );
        const since = cursor.lastEditedAfter
          ? new Date(new Date(cursor.lastEditedAfter).getTime() - CURSOR_OVERLAP_MS).toISOString()
          : undefined;

        let maxEdited = cursor.lastEditedAfter ?? null;
        const seen = new Set<string>();
        let next: string | null = null;
        do {
          const list = await client.queryDatabase(source.externalDatabaseId!, {
            editedOnOrAfter: since,
            startCursor: next,
          });
          for (const page of list.pages) {
            summary.pagesSeen += 1;
            seen.add(page.id);
            if (page.lastEditedTime && (!maxEdited || page.lastEditedTime > maxEdited))
              maxEdited = page.lastEditedTime;
            await this.processPage(ctx, source, ws, accounts, map, client, page, summary);
          }
          next = list.hasMore ? list.nextCursor : null;
        } while (next && summary.pagesSeen < MAX_PAGES_PER_RUN);

        await this.verifyScheduledPages(ctx, source, ws, accounts, map, client, seen, summary);
        summary.extras = await this.runCompanions(ctx, source, ws, map, client);

        // Companion services keep their own cursor keys; merge rather than replace.
        const [fresh] = await this.deps.db
          .select({ cursor: contentSource.cursor })
          .from(contentSource)
          .where(eq(contentSource.id, sourceId))
          .limit(1);
        const merged = { ...((fresh?.cursor ?? {}) as Record<string, unknown>) };
        if (maxEdited) merged['lastEditedAfter'] = maxEdited;
        else delete merged['lastEditedAfter'];
        const newCursor = merged;
        summary.cursor = maxEdited;
        await this.deps.db
          .update(contentSource)
          .set({
            cursor: newCursor,
            lastSyncAt: this.deps.clock.now(),
            lastError: null,
            status: 'active',
            updatedAt: this.deps.clock.now(),
          })
          .where(eq(contentSource.id, sourceId));
      });
      await recordAudit(this.deps.db, {
        workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: sourceId,
        event: 'content_source.synced',
        correlationId,
        data: {
          pagesSeen: summary.pagesSeen,
          actions: summary.actions,
          writebacks: summary.writebacks,
          errors: summary.errors.length,
        },
      });
    } catch (err) {
      const message = err instanceof NotionApiError ? err.message : 'Sync failed unexpectedly';
      const status =
        err instanceof NotionApiError && err.code === 'unauthorized' ? 'error' : 'active';
      summary.errors.push(message);
      this.deps.logger.warn({ err, sourceId, workspaceId }, 'notion sync failed');
      await this.deps.db
        .update(contentSource)
        .set({ lastError: message, status, updatedAt: this.deps.clock.now() })
        .where(eq(contentSource.id, sourceId));
      await recordAudit(this.deps.db, {
        workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: sourceId,
        event: 'content_source.sync_failed',
        correlationId,
        data: { message, code: err instanceof NotionApiError ? err.code : 'internal' },
      });
    }
    return summary;
  }

  /** Phase 4: campaigns, recurring/evergreen instances and idea promotion, each isolated. */
  private async runCompanions(
    ctx: TenantContext,
    source: ContentSource,
    ws: typeof workspace.$inferSelect,
    map: PropertyMap,
    client: NotionClient,
  ): Promise<NonNullable<SyncSummary['extras']>> {
    const extras: NonNullable<SyncSummary['extras']> = {
      campaignsSeen: 0,
      summariesWritten: 0,
      instancesCreated: 0,
      instancesUpdated: 0,
      evergreenFilled: 0,
      ideasSeen: 0,
      promoted: 0,
      warnings: [],
    };
    if (this.deps.campaigns) {
      try {
        const r = await this.deps.campaigns.syncFromNotion(ctx, source, client);
        extras.campaignsSeen = r.campaignsSeen;
        extras.summariesWritten = r.summariesWritten;
      } catch (err) {
        if (err instanceof NotionApiError && err.code === 'unauthorized') throw err;
        extras.warnings.push(`campaigns: ${(err as Error).message}`);
        this.deps.logger.warn({ err, sourceId: source.id }, 'campaign sync failed');
      }
    }
    if (this.deps.series) {
      const r = await this.deps.series.run(ctx, source, ws, map, client);
      extras.instancesCreated = r.instancesCreated;
      extras.instancesUpdated = r.instancesUpdated;
      extras.evergreenFilled = r.evergreenFilled;
      extras.warnings.push(...r.warnings);
    }
    if (this.deps.ideas) {
      try {
        const r = await this.deps.ideas.syncFromNotion(ctx, source, client);
        extras.ideasSeen = r.ideasSeen;
        extras.promoted = r.promoted;
      } catch (err) {
        if (err instanceof NotionApiError && err.code === 'unauthorized') throw err;
        extras.warnings.push(`ideas: ${(err as Error).message}`);
        this.deps.logger.warn({ err, sourceId: source.id }, 'idea sync failed');
      }
    }
    return extras;
  }

  private async processPage(
    ctx: TenantContext,
    source: ContentSource,
    ws: typeof workspace.$inferSelect,
    accounts: (typeof socialAccount.$inferSelect)[],
    map: PropertyMap,
    client: NotionClient,
    page: NotionPage,
    summary: SyncSummary,
  ): Promise<void> {
    const mapped = mapPage(page, map);
    try {
      const result = await this.deps.ingest.ingest({
        ctx,
        source,
        workspace: ws,
        page: mapped,
        loadBody: () => client.retrieveBlockChildren(page.id),
        accounts,
      });
      summary.actions[result.action] += 1;
      if (result.writeback) {
        const patch = writebackPatch(map, mapped.system, result.writeback);
        if (patch) {
          await client.updatePageProperties(page.id, patch);
          summary.writebacks += 1;
        }
      }
    } catch (err) {
      if (err instanceof NotionApiError) throw err; // token/rate problems abort the run
      const message = `page ${page.id}: ${(err as Error).message}`;
      summary.errors.push(message);
      this.deps.logger.error(
        { err, pageId: page.id, sourceId: source.id },
        'ingest failed for page',
      );
    }
  }

  /**
   * Pages we hold as scheduled but did not see in this incremental batch may
   * have been deleted or archived (deleted pages stop appearing in queries).
   */
  private async verifyScheduledPages(
    ctx: TenantContext,
    source: ContentSource,
    ws: typeof workspace.$inferSelect,
    accounts: (typeof socialAccount.$inferSelect)[],
    map: PropertyMap,
    client: NotionClient,
    seen: Set<string>,
    summary: SyncSummary,
  ): Promise<void> {
    const conditions = [
      eq(post.contentSourceId, source.id),
      eq(post.state, 'scheduled'),
      isNull(post.deletedAt),
      ne(post.externalId, ''),
    ];
    if (seen.size > 0) conditions.push(notInArray(post.externalId, [...seen]));
    const candidates = await this.deps.db
      .select({ externalId: post.externalId })
      .from(post)
      .where(and(...conditions))
      .limit(50);
    for (const c of candidates) {
      if (!c.externalId) continue;
      let page: NotionPage;
      try {
        page = await client.retrievePage(c.externalId);
      } catch (err) {
        if (err instanceof NotionApiError && err.code === 'not_found') {
          page = { id: c.externalId, url: '', archived: true, lastEditedTime: '', properties: {} };
        } else {
          throw err;
        }
      }
      if (page.archived) {
        summary.pagesSeen += 1;
        await this.processPage(ctx, source, ws, accounts, map, client, page, summary);
      }
    }
  }
}
