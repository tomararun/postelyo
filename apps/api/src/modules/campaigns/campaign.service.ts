import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  campaign,
  contentSource,
  post,
  publication,
  type Campaign,
  type ContentSource,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { NotionClient, NotionPage } from '../content-sources/notion/notion-client.js';
import { asRecord, richTextToPlain } from '../content-sources/notion/notion-client.js';
import { propName, type PropertyMap } from '../content-sources/notion/notion-mapper.js';
import { richText } from '../content-sources/notion/notion-writeback.js';
import { formatLocal } from '../scheduling/schedule-time.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 4 campaigns: pages of the Notion Campaigns database mirrored into
 * `campaign`, posts linked through the `Campaign` relation, and a summary
 * (counts, next publish, links) written back to the campaign page whenever it
 * changes. Runs inside the Notion sync so it needs no extra job or token read.
 */

export interface CampaignSummary {
  scheduled: number;
  published: number;
  failed: number;
  nextPublishAt: string | null;
  firstUrl: string | null;
  lastUrl: string | null;
  posts: number;
}

export interface CampaignDto {
  id: string;
  externalId: string;
  externalUrl: string | null;
  name: string;
  sourceStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  summary: CampaignSummary | null;
  summaryWrittenAt: Date | null;
}

interface CampaignConfig {
  campaignsDatabaseId?: string | null;
  campaignPropertyMap?: PropertyMap;
}

interface CampaignCursor {
  campaignsLastEditedAfter?: string;
}

export interface CampaignServiceDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

export class CampaignService {
  constructor(private readonly deps: CampaignServiceDeps) {}

  async list(ctx: TenantContext): Promise<CampaignDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(campaign)
        .where(and(eq(campaign.workspaceId, ctx.workspaceId), isNull(campaign.archivedAt)))
        .orderBy(campaign.name),
    );
    return rows.map(toDto);
  }

  /** Resolves (creating a placeholder when unknown) the campaign a post relates to. */
  async resolveForPost(
    ctx: TenantContext,
    source: Pick<ContentSource, 'id'>,
    campaignIds: string[],
  ): Promise<string | null> {
    const externalId = campaignIds[0];
    if (!externalId) return null;
    const [existing] = await this.deps.db
      .select({ id: campaign.id })
      .from(campaign)
      .where(and(eq(campaign.contentSourceId, source.id), eq(campaign.externalId, externalId)))
      .limit(1);
    if (existing) return existing.id;
    const id = uuidv7();
    const inserted = await this.deps.db
      .insert(campaign)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        contentSourceId: source.id,
        externalId,
        name: 'Campaign',
      })
      .onConflictDoNothing()
      .returning({ id: campaign.id });
    if (inserted.length > 0) return id;
    const [again] = await this.deps.db
      .select({ id: campaign.id })
      .from(campaign)
      .where(and(eq(campaign.contentSourceId, source.id), eq(campaign.externalId, externalId)))
      .limit(1);
    return again?.id ?? null;
  }

  /**
   * Incremental read of the Campaigns database (names, dates, status), then a
   * summary writeback for every campaign whose numbers changed. Called by the
   * Notion sync with an authenticated client.
   */
  async syncFromNotion(
    ctx: TenantContext,
    source: ContentSource,
    client: NotionClient,
  ): Promise<{ campaignsSeen: number; summariesWritten: number }> {
    const config = (source.config ?? {}) as CampaignConfig;
    const dbId = config.campaignsDatabaseId;
    if (!dbId) return { campaignsSeen: 0, summariesWritten: 0 };
    const map: PropertyMap = config.campaignPropertyMap ?? {};
    const cursor = (source.cursor ?? {}) as CampaignCursor;
    const since = cursor.campaignsLastEditedAfter
      ? new Date(new Date(cursor.campaignsLastEditedAfter).getTime() - 60_000).toISOString()
      : undefined;

    let seen = 0;
    let maxEdited = cursor.campaignsLastEditedAfter ?? null;
    let next: string | null = null;
    do {
      const list = await client.queryDatabase(dbId, { editedOnOrAfter: since, startCursor: next });
      for (const page of list.pages) {
        seen += 1;
        if (page.lastEditedTime && (!maxEdited || page.lastEditedTime > maxEdited))
          maxEdited = page.lastEditedTime;
        await this.upsertFromPage(ctx, source, map, page);
      }
      next = list.hasMore ? list.nextCursor : null;
    } while (next && seen < 500);

    if (maxEdited && maxEdited !== cursor.campaignsLastEditedAfter) {
      await this.deps.db
        .update(contentSource)
        .set({
          cursor: {
            ...(source.cursor as Record<string, unknown>),
            campaignsLastEditedAfter: maxEdited,
          },
        })
        .where(eq(contentSource.id, source.id));
    }

    const summariesWritten = await this.writeSummaries(ctx, source, map, client);
    return { campaignsSeen: seen, summariesWritten };
  }

  private async upsertFromPage(
    ctx: TenantContext,
    source: ContentSource,
    map: PropertyMap,
    page: NotionPage,
  ): Promise<void> {
    const prop = (name: string) => page.properties[propName(map, name)] ?? {};
    const titleProp =
      Object.values(page.properties).find((p) => p['type'] === 'title') ?? prop('Name');
    const name = richTextToPlain(titleProp['title']) || 'Untitled campaign';
    const statusProp = prop('Status');
    const status = asRecord(statusProp['select'] ?? statusProp['status']);
    const start = asRecord(prop('Start')['date']);
    const end = asRecord(prop('End')['date']);
    const now = this.deps.clock.now();
    const values = {
      name,
      externalUrl: page.url || null,
      sourceStatus: typeof status['name'] === 'string' ? status['name'] : null,
      startsOn: typeof start['start'] === 'string' ? start['start'].slice(0, 10) : null,
      endsOn: typeof end['start'] === 'string' ? end['start'].slice(0, 10) : null,
      archivedAt: page.archived ? now : null,
      updatedAt: now,
    };
    await this.deps.db
      .insert(campaign)
      .values({
        id: uuidv7(),
        workspaceId: ctx.workspaceId,
        contentSourceId: source.id,
        externalId: page.id,
        ...values,
      })
      .onConflictDoUpdate({
        target: [campaign.contentSourceId, campaign.externalId],
        set: values,
      });
  }

  async summaryFor(campaignId: string): Promise<CampaignSummary> {
    const rows = await this.deps.db
      .select({
        state: publication.state,
        scheduledAt: publication.scheduledAt,
        publishedAt: publication.publishedAt,
        url: publication.providerPostUrl,
        postId: post.id,
      })
      .from(publication)
      .innerJoin(post, eq(post.id, publication.postId))
      .where(and(eq(post.campaignId, campaignId), isNull(post.deletedAt)));
    const now = this.deps.clock.now();
    const waiting = rows.filter((r) =>
      ['pending', 'scheduled', 'blocked', 'queued', 'publishing', 'retry_wait'].includes(r.state),
    );
    const published = rows
      .filter((r) => r.state === 'published')
      .sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0));
    const next = waiting
      .map((r) => r.scheduledAt)
      .filter((d) => d.getTime() >= now.getTime() - 60_000)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      scheduled: waiting.length,
      published: published.length,
      failed: rows.filter((r) => r.state === 'failed' || r.state === 'ambiguous').length,
      nextPublishAt: next ? next.toISOString() : null,
      firstUrl: published.find((p) => p.url)?.url ?? null,
      lastUrl: [...published].reverse().find((p) => p.url)?.url ?? null,
      posts: new Set(rows.map((r) => r.postId)).size,
    };
  }

  /** Writes changed summaries to the campaign pages; audited once per change. */
  private async writeSummaries(
    ctx: TenantContext,
    source: ContentSource,
    map: PropertyMap,
    client: NotionClient,
  ): Promise<number> {
    const campaigns = await this.deps.db
      .select()
      .from(campaign)
      .where(and(eq(campaign.contentSourceId, source.id), isNull(campaign.archivedAt)));
    if (campaigns.length === 0) return 0;
    const linked = await this.deps.db
      .select({ campaignId: post.campaignId })
      .from(post)
      .where(
        and(
          inArray(
            post.campaignId,
            campaigns.map((c) => c.id),
          ),
          isNull(post.deletedAt),
        ),
      );
    const withPosts = new Set(linked.map((l) => l.campaignId));
    let written = 0;
    for (const c of campaigns) {
      if (!withPosts.has(c.id) && !c.summaryHash) continue;
      const summary = await this.summaryFor(c.id);
      const hash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
      if (hash === c.summaryHash) continue;
      const tz = 'UTC';
      const lines = [
        `${summary.published} published, ${summary.scheduled} scheduled, ${summary.failed} failed (${summary.posts} posts).`,
        summary.nextPublishAt
          ? `Next publish ${formatLocal(new Date(summary.nextPublishAt), tz)} UTC.`
          : '',
        summary.firstUrl ? `First: ${summary.firstUrl}` : '',
        summary.lastUrl && summary.lastUrl !== summary.firstUrl ? `Latest: ${summary.lastUrl}` : '',
      ].filter((l) => l.length > 0);
      const props: Record<string, unknown> = {};
      const has = (name: string) => Boolean(map[name]);
      if (has('Scheduled')) props[map['Scheduled']!] = { number: summary.scheduled };
      if (has('Published')) props[map['Published']!] = { number: summary.published };
      if (has('Failed')) props[map['Failed']!] = { number: summary.failed };
      if (has('Next Publish'))
        props[map['Next Publish']!] = {
          date: summary.nextPublishAt ? { start: summary.nextPublishAt } : null,
        };
      if (has('Postelyo Summary'))
        props[map['Postelyo Summary']!] = { rich_text: richText(lines.join('\n')) };
      if (Object.keys(props).length > 0) {
        try {
          await client.updatePageProperties(c.externalId, props);
        } catch (err) {
          this.deps.logger.warn({ err, campaignId: c.id }, 'campaign summary writeback failed');
          continue;
        }
      }
      const now = this.deps.clock.now();
      await this.deps.db
        .update(campaign)
        .set({ summary, summaryHash: hash, summaryWrittenAt: now, updatedAt: now })
        .where(eq(campaign.id, c.id));
      await recordAudit(this.deps.db, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'campaign',
        entityId: c.id,
        event: 'campaign.summary_written',
        correlationId: ctx.correlationId,
        data: { ...summary },
      });
      written += 1;
    }
    return written;
  }
}

function toDto(c: Campaign): CampaignDto {
  return {
    id: c.id,
    externalId: c.externalId,
    externalUrl: c.externalUrl,
    name: c.name,
    sourceStatus: c.sourceStatus,
    startsOn: c.startsOn,
    endsOn: c.endsOn,
    summary: (c.summary as CampaignSummary | null) ?? null,
    summaryWrittenAt: c.summaryWrittenAt,
  };
}
