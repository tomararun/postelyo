import { describe, expect, it } from 'vitest';
import { POSTELYO_STATUS, clearedWriteback, writebackPatch } from './notion-writeback.js';

const current = {
  postelyoStatus: null,
  postelyoNote: '',
  publishedUrl: null,
  publishedAt: null,
  postelyoId: '',
  publishedUrls: null,
  approval: null,
  linkReport: null,
};

describe('writebackPatch', () => {
  it('emits only changed properties using the property map', () => {
    const patch = writebackPatch(
      { 'Postelyo Status': 'PStatus' },
      { ...current, postelyoNote: 'same' },
      { postelyoStatus: POSTELYO_STATUS.scheduled, postelyoNote: 'same', postelyoId: 'pub-1' },
    );
    expect(patch).toEqual({
      PStatus: { select: { name: 'Scheduled' } },
      'Postelyo ID': { rich_text: [{ type: 'text', text: { content: 'pub-1' } }] },
    });
  });

  it('returns null when nothing differs', () => {
    expect(
      writebackPatch(
        {},
        { ...current, postelyoStatus: 'Scheduled', postelyoNote: 'n', postelyoId: 'x' },
        { postelyoStatus: POSTELYO_STATUS.scheduled, postelyoNote: 'n', postelyoId: 'x' },
      ),
    ).toBeNull();
  });

  it('clears values with null selects and empty rich text, and truncates long notes', () => {
    const patch = writebackPatch(
      {},
      { ...current, postelyoStatus: 'Scheduled', postelyoNote: 'old', postelyoId: 'x' },
      { postelyoStatus: null, postelyoNote: 'y'.repeat(3000), postelyoId: '' },
    );
    expect(patch?.['Postelyo Status']).toEqual({ select: null });
    expect(patch?.['Postelyo ID']).toEqual({ rich_text: [] });
    const note = (patch?.['Postelyo Note'] as { rich_text: { text: { content: string } }[] })
      .rich_text[0]!.text.content;
    expect(note.length).toBeLessThanOrEqual(1900);
    expect(note.endsWith('…')).toBe(true);
  });

  it('writes published fields only when provided', () => {
    const patch = writebackPatch({}, current, {
      postelyoStatus: POSTELYO_STATUS.published,
      postelyoNote: '',
      postelyoId: 'p',
      publishedUrl: 'https://l.in/x',
      publishedAt: '2026-10-01T07:00:00.000Z',
    });
    expect(patch?.['Published URL']).toEqual({ url: 'https://l.in/x' });
    expect(patch?.['Published At']).toEqual({ date: { start: '2026-10-01T07:00:00.000Z' } });
  });
});

describe('clearedWriteback', () => {
  it('clears pre-publish statuses but never Published/Failed', () => {
    expect(clearedWriteback({ ...current, postelyoStatus: 'Awaiting schedule' })).toEqual({
      postelyoStatus: null,
      postelyoNote: '',
      postelyoId: '',
    });
    expect(clearedWriteback({ ...current, postelyoStatus: 'Published' })).toBeNull();
    expect(clearedWriteback(current)).toBeNull();
  });
});
