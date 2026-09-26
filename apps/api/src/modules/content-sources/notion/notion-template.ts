import type { NotionClient } from './notion-client.js';
import { NOTION_CONTRACT } from './notion-schema.js';

/**
 * The Postelyo content database as a Notion `create database` request
 * (docs/notion-template.md). Property names and options match the contract in
 * notion-schema.ts, so a database created from this passes validation as is.
 *
 * Phase 4 (template v2): the content database gets `Campaign`, `Repeat`,
 * `Repeat Until`, `First Comment` and the system columns `Repeat Of`,
 * `Approval`, `Link Report`; two companion databases (`Postelyo Campaigns`,
 * `Postelyo Ideas`) are created next to it. Notion's API cannot create views,
 * so the views ship in the public template page users duplicate during OAuth.
 */

export const TEMPLATE_TITLE = 'Postelyo Content';
export const CAMPAIGNS_TITLE = 'Postelyo Campaigns';
export const IDEAS_TITLE = 'Postelyo Ideas';
export const ANALYTICS_TITLE = 'Postelyo Analytics';

export const STATUS_OPTIONS = [
  { name: 'Idea', color: 'gray' },
  { name: 'Draft', color: 'default' },
  { name: 'In review', color: 'yellow' },
  { name: 'Changes requested', color: 'orange' },
  { name: 'Ready', color: 'blue' },
  { name: 'Scheduled', color: 'purple' },
  { name: 'Cancelled', color: 'red' },
] as const;

export const POSTELYO_STATUS_OPTIONS = [
  { name: 'Awaiting schedule', color: 'gray' },
  { name: 'Awaiting approval', color: 'gray' },
  { name: 'In evergreen pool', color: 'gray' },
  { name: 'Validation error', color: 'red' },
  { name: 'Scheduled', color: 'blue' },
  { name: 'Publishing', color: 'yellow' },
  { name: 'Published', color: 'green' },
  { name: 'Published late', color: 'green' },
  { name: 'Failed', color: 'red' },
  { name: 'Partially failed', color: 'orange' },
  { name: 'Needs review', color: 'orange' },
  { name: 'Needs re-authorization', color: 'orange' },
] as const;

export const PLATFORM_OPTIONS = [
  { name: 'LinkedIn', color: 'blue' },
  { name: 'LinkedIn Page', color: 'blue' },
  { name: 'X', color: 'default' },
  { name: 'Facebook Page', color: 'purple' },
  { name: 'Instagram', color: 'pink' },
] as const;

/** Phase 4 `Repeat` options; `Evergreen` puts the page in the re-share pool instead of a fixed cadence. */
export const REPEAT_OPTIONS = [
  { name: 'Weekly', color: 'blue' },
  { name: 'Every 2 weeks', color: 'blue' },
  { name: 'Monthly', color: 'blue' },
  { name: 'Evergreen', color: 'green' },
] as const;

export const APPROVAL_OPTIONS = [
  { name: 'Awaiting approval', color: 'yellow' },
  { name: 'Approved', color: 'green' },
  { name: 'Changes since approval', color: 'orange' },
] as const;

export const CAMPAIGN_STATUS_OPTIONS = [
  { name: 'Planned', color: 'gray' },
  { name: 'Active', color: 'blue' },
  { name: 'Done', color: 'green' },
] as const;

export const IDEA_STATUS_OPTIONS = [
  { name: 'New', color: 'gray' },
  { name: 'Promote', color: 'blue' },
  { name: 'Promoted', color: 'green' },
] as const;

/** Notion API property definitions for `POST /v1/databases` (content database, without relations). */
export function templateProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Status: { select: { options: [...STATUS_OPTIONS] } },
    'Publish Date': { date: {} },
    Platforms: { multi_select: { options: [...PLATFORM_OPTIONS] } },
    'Post Text': { rich_text: {} },
    Media: { files: {} },
    'Time Zone': { select: { options: [] } },
    'LinkedIn Text': { rich_text: {} },
    'X Text': { rich_text: {} },
    'Facebook Text': { rich_text: {} },
    'Instagram Caption': { rich_text: {} },
    // Phase 4 (v2)
    Repeat: { select: { options: [...REPEAT_OPTIONS] } },
    'Repeat Until': { date: {} },
    'First Comment': { rich_text: {} },
    Approval: { select: { options: [...APPROVAL_OPTIONS] } },
    'Link Report': { rich_text: {} },
    // Phase 5 metrics
    Impressions: { number: {} },
    Reach: { number: {} },
    Reactions: { number: {} },
    Comments: { number: {} },
    Shares: { number: {} },
    Clicks: { number: {} },
    'Metrics Updated': { date: {} },
    // System
    'Postelyo Status': { select: { options: [...POSTELYO_STATUS_OPTIONS] } },
    'Postelyo Note': { rich_text: {} },
    'Published URL': { url: {} },
    'Published URLs': { rich_text: {} },
    'Published At': { date: {} },
    'Postelyo ID': { rich_text: {} },
  };
}

/** Relation properties need the target database id, so they are added after creation. */
export function templateRelationProperties(
  contentDatabaseId: string,
  campaignsDatabaseId: string | null,
): Record<string, unknown> {
  return {
    ...(campaignsDatabaseId
      ? { Campaign: { relation: { database_id: campaignsDatabaseId, single_property: {} } } }
      : {}),
    'Repeat Of': { relation: { database_id: contentDatabaseId, single_property: {} } },
  };
}

export function campaignsProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Status: { select: { options: [...CAMPAIGN_STATUS_OPTIONS] } },
    Start: { date: {} },
    End: { date: {} },
    // System-written summary (Phase 4)
    Scheduled: { number: {} },
    Published: { number: {} },
    Failed: { number: {} },
    'Next Publish': { date: {} },
    'Postelyo Summary': { rich_text: {} },
  };
}

export function analyticsProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Week: { date: {} },
    Platform: { select: { options: [...PLATFORM_OPTIONS, { name: 'All', color: 'gray' }] } },
    Posts: { number: {} },
    Impressions: { number: {} },
    Reach: { number: {} },
    Reactions: { number: {} },
    Comments: { number: {} },
    Shares: { number: {} },
    Clicks: { number: {} },
    Saves: { number: {} },
    'Engagement Rate': { number: { format: 'percent' } },
    'Best Time': { rich_text: {} },
  };
}

export function analyticsCreateBody(
  parentPageId: string,
  title = ANALYTICS_TITLE,
): Record<string, unknown> {
  return createBody(parentPageId, title, analyticsProperties());
}

export function ideasProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Status: { select: { options: [...IDEA_STATUS_OPTIONS] } },
    Notes: { rich_text: {} },
    Platforms: { multi_select: { options: [...PLATFORM_OPTIONS] } },
    // System-written after promotion
    'Post URL': { url: {} },
  };
}

/** Sanity check used by tests and the CLI: every non-relation contract property is present in the template. */
export function templateCoversContract(): string[] {
  const props = templateProperties();
  const relations = templateRelationProperties('x', 'y');
  return NOTION_CONTRACT.filter((c) => !(c.name in props) && !(c.name in relations)).map(
    (c) => c.name,
  );
}

function createBody(
  parentPageId: string,
  title: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    is_inline: false,
    properties,
  };
}

export function templateCreateBody(
  parentPageId: string,
  title = TEMPLATE_TITLE,
): Record<string, unknown> {
  return createBody(parentPageId, title, templateProperties());
}

export function campaignsCreateBody(
  parentPageId: string,
  title = CAMPAIGNS_TITLE,
): Record<string, unknown> {
  return createBody(parentPageId, title, campaignsProperties());
}

export function ideasCreateBody(
  parentPageId: string,
  title = IDEAS_TITLE,
): Record<string, unknown> {
  return createBody(parentPageId, title, ideasProperties());
}

export interface TemplateSuite {
  contentDatabaseId: string;
  contentUrl: string;
  campaignsDatabaseId: string;
  ideasDatabaseId: string;
  analyticsDatabaseId: string;
}

/**
 * Creates the three Phase 4 databases under `parentPageId` and wires the
 * relations: `Campaign` → campaigns database, `Repeat Of` → the content
 * database itself. Order matters: the content database must exist before its
 * self-relation can be added.
 */
export async function createTemplateSuite(
  client: NotionClient,
  parentPageId: string,
  title = TEMPLATE_TITLE,
): Promise<TemplateSuite> {
  const campaigns = await client.createDatabase(campaignsCreateBody(parentPageId));
  const ideas = await client.createDatabase(ideasCreateBody(parentPageId));
  const analytics = await client.createDatabase(analyticsCreateBody(parentPageId));
  const content = await client.createDatabase(templateCreateBody(parentPageId, title));
  await client.updateDatabase(content.id, {
    properties: templateRelationProperties(content.id, campaigns.id),
  });
  return {
    contentDatabaseId: content.id,
    contentUrl: content.url,
    campaignsDatabaseId: campaigns.id,
    ideasDatabaseId: ideas.id,
    analyticsDatabaseId: analytics.id,
  };
}
