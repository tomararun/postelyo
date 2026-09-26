import { describe, expect, it } from 'vitest';
import { formatLocal, resolveSchedule, zonedTimeToUtc } from './schedule-time.js';

const base = { workspaceTimeZone: 'Europe/Berlin', defaultPublishTime: '09:00' };

describe('resolveSchedule', () => {
  it('uses the workspace default time for date-only values in the workspace zone', () => {
    const r = resolveSchedule({ ...base, date: { start: '2026-10-01' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 09:00 CEST (+02:00) on 1 October.
    expect(r.value.scheduledAt.toISOString()).toBe('2026-10-01T07:00:00.000Z');
    expect(r.value.local).toBe('2026-10-01T09:00');
    expect(r.value.timeZone).toBe('Europe/Berlin');
    expect(r.value.warnings[0]).toMatch(/No time set/);
  });

  it('interprets a local date-time in the resolved zone', () => {
    const r = resolveSchedule({ ...base, date: { start: '2026-01-15T18:30:00.000' } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.scheduledAt.toISOString()).toBe('2026-01-15T17:30:00.000Z');
    expect(r.value.local).toBe('2026-01-15T18:30');
  });

  it('keeps an absolute instant when the source provides an offset', () => {
    const r = resolveSchedule({ ...base, date: { start: '2026-07-01T09:00:00.000-04:00' } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.scheduledAt.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(r.value.local).toBe('2026-07-01T15:00');
  });

  it('prefers the date time zone, then the post time zone, then the workspace', () => {
    const viaDate = resolveSchedule({
      ...base,
      date: { start: '2026-10-01T09:00:00.000', timeZone: 'America/New_York' },
      postTimeZone: 'Asia/Tokyo',
    });
    if (!viaDate.ok) throw new Error(viaDate.error.message);
    expect(viaDate.value.timeZone).toBe('America/New_York');
    expect(viaDate.value.scheduledAt.toISOString()).toBe('2026-10-01T13:00:00.000Z');

    const viaPost = resolveSchedule({
      ...base,
      date: { start: '2026-10-01' },
      postTimeZone: 'Asia/Tokyo',
    });
    if (!viaPost.ok) throw new Error(viaPost.error.message);
    expect(viaPost.value.timeZone).toBe('Asia/Tokyo');
    expect(viaPost.value.scheduledAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');

    const badPost = resolveSchedule({
      ...base,
      date: { start: '2026-10-01' },
      postTimeZone: 'Mars/Olympus',
    });
    if (!badPost.ok) throw new Error(badPost.error.message);
    expect(badPost.value.timeZone).toBe('Europe/Berlin');
    expect(badPost.value.warnings.some((w) => w.includes('Mars/Olympus'))).toBe(true);
  });

  it('handles the spring-forward gap by moving forward and warning', () => {
    // 2026-03-29 02:30 does not exist in Europe/Berlin (clocks jump 02:00 → 03:00).
    const r = resolveSchedule({ ...base, date: { start: '2026-03-29T02:30:00.000' } });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.scheduledAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(formatLocal(r.value.scheduledAt, 'Europe/Berlin')).toBe('2026-03-29T03:30');
    expect(r.value.warnings.some((w) => w.includes('daylight-saving'))).toBe(true);
  });

  it('resolves the fall-back ambiguity to the first occurrence', () => {
    // 2026-10-25 02:30 occurs twice in Europe/Berlin; first is CEST (+02:00).
    const d = zonedTimeToUtc(2026, 10, 25, 2, 30, 0, 'Europe/Berlin');
    expect(d.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('rejects invalid dates and zones', () => {
    expect(resolveSchedule({ ...base, date: { start: '2026-13-01' } })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DATE' },
    });
    expect(resolveSchedule({ ...base, date: { start: 'tomorrow' } })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DATE' },
    });
    expect(
      resolveSchedule({ ...base, workspaceTimeZone: 'Nope/Nope', date: { start: '2026-10-01' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TIMEZONE' },
    });
    expect(
      resolveSchedule({ ...base, defaultPublishTime: '25:00', date: { start: '2026-10-01' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_DATE' },
    });
  });
});
