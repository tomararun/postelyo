import { propName, type PropertyMap, type SourcePost } from './notion-mapper.js';

/**
 * System-owned Notion properties (PRD §4.4). Values are computed from our state
 * and patched only when they differ from what the page currently shows, so
 * repeated syncs are idempotent and never fight the user's columns.
 */

export const POSTELYO_STATUS = {
  awaitingSchedule: 'Awaiting schedule',
  awaitingApproval: 'Awaiting approval',
  evergreenPool: 'In evergreen pool',
  validationError: 'Validation error',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  publishedLate: 'Published late',
  failed: 'Failed',
  partiallyFailed: 'Partially failed',
  needsReview: 'Needs review',
  needsReauth: 'Needs re-authorization',
} as const;

export type PostelyoStatus = (typeof POSTELYO_STATUS)[keyof typeof POSTELYO_STATUS];

/** Statuses the sync may clear when a page leaves the scheduling flow. */
export const PRE_PUBLISH_STATUSES: readonly string[] = [
  POSTELYO_STATUS.awaitingSchedule,
  POSTELYO_STATUS.awaitingApproval,
  POSTELYO_STATUS.evergreenPool,
  POSTELYO_STATUS.validationError,
  POSTELYO_STATUS.scheduled,
  POSTELYO_STATUS.needsReauth,
];

export interface DesiredWriteback {
  postelyoStatus: PostelyoStatus | null;
  postelyoNote: string;
  postelyoId: string;
  publishedUrl?: string | null;
  publishedAt?: string | null;
  /** One `<label>: <url>` per platform (Phase 2); written only when the database has the property. */
  publishedUrls?: { label: string; url: string }[];
  /** Phase 4 approval column (`Awaiting approval`, `Approved`, `Changes since approval`); null clears. */
  approval?: string | null;
  /** Phase 4 tracked links, one `<short> → <target>` per line; written only when the column exists. */
  linkReport?: string;
}

/** Phase 4 approval column values. */
export const APPROVAL_STATUS = {
  awaiting: 'Awaiting approval',
  approved: 'Approved',
  changed: 'Changes since approval',
} as const;

/** Notion rich_text objects are capped at 2 000 characters; keep a margin for safety. */
const MAX_NOTE = 1_900;

export function richText(text: string): unknown[] {
  const t = text.length > MAX_NOTE ? text.slice(0, MAX_NOTE - 1) + '…' : text;
  return t.length === 0 ? [] : [{ type: 'text', text: { content: t } }];
}

/**
 * Builds the PATCH body for the properties that differ between the page's
 * current system values and `desired`. Returns null when nothing changed.
 */
export function writebackPatch(
  map: PropertyMap,
  current: SourcePost['system'],
  desired: DesiredWriteback,
): Record<string, unknown> | null {
  const props: Record<string, unknown> = {};

  if ((current.postelyoStatus ?? null) !== desired.postelyoStatus) {
    props[propName(map, 'Postelyo Status')] = {
      select: desired.postelyoStatus ? { name: desired.postelyoStatus } : null,
    };
  }
  const note =
    desired.postelyoNote.length > MAX_NOTE
      ? desired.postelyoNote.slice(0, MAX_NOTE - 1) + '…'
      : desired.postelyoNote;
  if (current.postelyoNote !== note) {
    props[propName(map, 'Postelyo Note')] = { rich_text: richText(note) };
  }
  if (current.postelyoId !== desired.postelyoId) {
    props[propName(map, 'Postelyo ID')] = { rich_text: richText(desired.postelyoId) };
  }
  if (
    desired.publishedUrl !== undefined &&
    (current.publishedUrl ?? null) !== desired.publishedUrl
  ) {
    props[propName(map, 'Published URL')] = { url: desired.publishedUrl };
  }
  if (desired.publishedAt !== undefined && (current.publishedAt ?? null) !== desired.publishedAt) {
    props[propName(map, 'Published At')] = {
      date: desired.publishedAt ? { start: desired.publishedAt } : null,
    };
  }
  // Optional column: only databases that have it get the per-platform links.
  if (desired.publishedUrls !== undefined && map['Published URLs']) {
    const text = desired.publishedUrls.map((u) => `${u.label}: ${u.url}`).join('\n');
    if ((current.publishedUrls ?? '') !== text) {
      props[map['Published URLs']] = {
        rich_text: desired.publishedUrls.flatMap((u, i) => [
          { type: 'text', text: { content: `${i > 0 ? '\n' : ''}${u.label}: ` } },
          { type: 'text', text: { content: u.url, link: { url: u.url } } },
        ]),
      };
    }
  }
  if (desired.approval !== undefined && map['Approval']) {
    if ((current.approval ?? null) !== desired.approval) {
      props[map['Approval']] = { select: desired.approval ? { name: desired.approval } : null };
    }
  }
  if (desired.linkReport !== undefined && map['Link Report']) {
    if ((current.linkReport ?? '') !== desired.linkReport) {
      props[map['Link Report']] = { rich_text: richText(desired.linkReport) };
    }
  }
  return Object.keys(props).length === 0 ? null : props;
}

/** Writeback that clears our pre-publish status; leaves Published/Failed untouched. */
export function clearedWriteback(current: SourcePost['system']): DesiredWriteback | null {
  if (current.postelyoStatus && !PRE_PUBLISH_STATUSES.includes(current.postelyoStatus)) return null;
  if (!current.postelyoStatus && current.postelyoNote === '' && current.postelyoId === '')
    return null;
  return { postelyoStatus: null, postelyoNote: '', postelyoId: '' };
}
