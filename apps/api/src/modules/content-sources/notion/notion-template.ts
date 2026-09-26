import { NOTION_CONTRACT } from './notion-schema.js';

/**
 * The Postelyo content database as a Notion `create database` request
 * (docs/notion-template.md). Property names and options match the contract in
 * notion-schema.ts, so a database created from this passes validation as is.
 */

export const TEMPLATE_TITLE = 'Postelyo Content';

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
  { name: 'Validation error', color: 'red' },
  { name: 'Scheduled', color: 'blue' },
  { name: 'Publishing', color: 'yellow' },
  { name: 'Published', color: 'green' },
  { name: 'Published late', color: 'green' },
  { name: 'Failed', color: 'red' },
  { name: 'Needs review', color: 'orange' },
  { name: 'Needs re-authorization', color: 'orange' },
] as const;

export const PLATFORM_OPTIONS = [
  { name: 'LinkedIn', color: 'blue' },
  { name: 'LinkedIn Page', color: 'blue' },
] as const;

/** Notion API property definitions for `POST /v1/databases`. */
export function templateProperties(): Record<string, unknown> {
  return {
    Name: { title: {} },
    Status: { select: { options: [...STATUS_OPTIONS] } },
    'Publish Date': { date: {} },
    Platforms: { multi_select: { options: [...PLATFORM_OPTIONS] } },
    'Post Text': { rich_text: {} },
    Media: { files: {} },
    'Time Zone': { select: { options: [] } },
    'Postelyo Status': { select: { options: [...POSTELYO_STATUS_OPTIONS] } },
    'Postelyo Note': { rich_text: {} },
    'Published URL': { url: {} },
    'Published At': { date: {} },
    'Postelyo ID': { rich_text: {} },
  };
}

/** Sanity check used by tests and the CLI: every contract property is present in the template. */
export function templateCoversContract(): string[] {
  const props = templateProperties();
  return NOTION_CONTRACT.filter((c) => !(c.name in props)).map((c) => c.name);
}

export function templateCreateBody(
  parentPageId: string,
  title = TEMPLATE_TITLE,
): Record<string, unknown> {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    is_inline: false,
    properties: templateProperties(),
  };
}
