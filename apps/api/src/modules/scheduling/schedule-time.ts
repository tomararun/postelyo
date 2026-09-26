import { isValidTimeZone } from '../workspaces/timezone.js';

/**
 * Timezone-aware schedule resolution (architecture §8.1, PRD §4.5).
 *
 * Resolution order for the zone: source date time zone → post-level time zone
 * property → workspace default. Dates without a time use the workspace default
 * publish time. Everything is computed with the IANA database via Intl.
 */

export interface SourceDate {
  /** Notion `date.start`: "2026-10-01", "2026-10-01T09:00:00.000+02:00" or "2026-10-01T09:00:00.000". */
  start: string;
  /** Notion `date.time_zone` (IANA) when the user picked one. */
  timeZone?: string | null | undefined;
}

export interface ScheduleInput {
  date: SourceDate;
  /** Optional post-level IANA override (Notion "Time Zone" property). */
  postTimeZone?: string | null | undefined;
  workspaceTimeZone: string;
  /** "HH:MM" or "HH:MM:SS" used when the date has no time. */
  defaultPublishTime: string;
}

export interface ResolvedSchedule {
  scheduledAt: Date;
  timeZone: string;
  /** Wall-clock the user intended, "YYYY-MM-DDTHH:MM". */
  local: string;
  warnings: string[];
}

export type ScheduleError =
  { code: 'INVALID_DATE'; message: string } | { code: 'INVALID_TIMEZONE'; message: string };

export type ScheduleResult =
  { ok: true; value: ResolvedSchedule } | { ok: false; error: ScheduleError };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

export function resolveSchedule(input: ScheduleInput): ScheduleResult {
  const warnings: string[] = [];

  const tzCandidates: [string | null | undefined, string][] = [
    [input.date.timeZone, 'date'],
    [input.postTimeZone, 'post'],
    [input.workspaceTimeZone, 'workspace'],
  ];
  let timeZone: string | undefined;
  for (const [tz, origin] of tzCandidates) {
    if (!tz || tz.trim().length === 0) continue;
    if (!isValidTimeZone(tz.trim())) {
      if (origin === 'workspace') {
        return {
          ok: false,
          error: { code: 'INVALID_TIMEZONE', message: `Workspace time zone "${tz}" is invalid` },
        };
      }
      warnings.push(`Ignored unknown time zone "${tz}"; using the next fallback.`);
      continue;
    }
    timeZone = tz.trim();
    break;
  }
  if (!timeZone) {
    return {
      ok: false,
      error: { code: 'INVALID_TIMEZONE', message: 'No valid time zone available' },
    };
  }

  const start = input.date.start.trim();
  const dateOnly = DATE_ONLY.exec(start);
  const dateTime = DATE_TIME.exec(start);

  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const time = parseTime(input.defaultPublishTime);
    if (!time) {
      return {
        ok: false,
        error: {
          code: 'INVALID_DATE',
          message: `Invalid default publish time "${input.defaultPublishTime}"`,
        },
      };
    }
    return finish(Number(y), Number(m), Number(d), time.h, time.mi, timeZone, warnings, true);
  }

  if (dateTime) {
    const [, y, m, d, h, mi, s, offset] = dateTime;
    if (offset) {
      // Absolute instant from the source; the wall-clock shown to the user is in the resolved zone.
      const instant = new Date(
        start.replace(/(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, (_, __, o: string) => o),
      );
      if (Number.isNaN(instant.getTime())) {
        return {
          ok: false,
          error: { code: 'INVALID_DATE', message: `Unparseable date "${start}"` },
        };
      }
      return {
        ok: true,
        value: { scheduledAt: instant, timeZone, local: formatLocal(instant, timeZone), warnings },
      };
    }
    return finish(
      Number(y),
      Number(m),
      Number(d),
      Number(h),
      Number(mi),
      timeZone,
      warnings,
      false,
      Number(s ?? 0),
    );
  }

  return { ok: false, error: { code: 'INVALID_DATE', message: `Unparseable date "${start}"` } };
}

function finish(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
  warnings: string[],
  usedDefaultTime: boolean,
  s = 0,
): ScheduleResult {
  if (!isValidCalendarDate(y, m, d) || h > 23 || mi > 59) {
    return { ok: false, error: { code: 'INVALID_DATE', message: 'Invalid calendar date or time' } };
  }
  const scheduledAt = zonedTimeToUtc(y, m, d, h, mi, s, timeZone);
  const requested = pad(y, 4) + '-' + pad(m) + '-' + pad(d) + 'T' + pad(h) + ':' + pad(mi);
  const actual = formatLocal(scheduledAt, timeZone);
  if (actual !== requested) {
    warnings.push(
      `${requested} does not exist in ${timeZone} (daylight-saving change); publishing at ${actual} instead.`,
    );
  }
  if (usedDefaultTime)
    warnings.push(`No time set; using the workspace default ${pad(h)}:${pad(mi)} ${timeZone}.`);
  return { ok: true, value: { scheduledAt, timeZone, local: requested, warnings } };
}

// ---------------------------------------------------------------------------
// Intl-based zone arithmetic (no fixed offsets, architecture §8.1)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock components of `date` in `timeZone`. */
export function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    dtf(timeZone)
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return parts;
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function offsetAt(timeZone: string, utcMs: number): number {
  const w = wallClock(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - utcMs;
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant. Non-existent local
 * times (spring-forward gap) resolve forward; ambiguous times (fall-back) resolve
 * to the first occurrence.
 */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const local = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = local - offsetAt(timeZone, local);
  for (let i = 0; i < 3; i++) {
    const next = local - offsetAt(timeZone, guess);
    if (next === guess) break;
    guess = next;
  }
  // Prefer the earlier of two valid candidates (fall-back ambiguity).
  const earlier = guess - 3_600_000;
  if (local - offsetAt(timeZone, earlier) === earlier) return new Date(earlier);
  return new Date(guess);
}

export function formatLocal(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

function parseTime(t: string): { h: number; mi: number } | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
