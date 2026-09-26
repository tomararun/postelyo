import { describe, expect, it } from 'vitest';
import type { NotionBlock, NotionPage } from './notion-client.js';
import {
  blocksToCanonical,
  buildCanonicalContent,
  mapPage,
  richTextToInlines,
} from './notion-mapper.js';

const rt = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'text',
  plain_text: text,
  href: null,
  annotations: { bold: false, italic: false },
  ...extra,
});

function page(overrides: Partial<NotionPage['properties']> = {}): NotionPage {
  return {
    id: 'page-1',
    url: 'https://www.notion.so/page-1',
    archived: false,
    lastEditedTime: '2026-09-23T10:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [rt('Launch post')] },
      Status: { type: 'status', status: { name: 'Scheduled' } },
      'Publish Date': {
        type: 'date',
        date: { start: '2026-10-01T09:00:00.000+02:00', time_zone: null },
      },
      Platforms: { type: 'multi_select', multi_select: [{ name: 'LinkedIn' }] },
      'Post Text': { type: 'rich_text', rich_text: [rt('Fallback text')] },
      Media: {
        type: 'files',
        files: [
          { name: 'hero.png', type: 'file', file: { url: 'https://s3/hero.png?sig=1' } },
          { name: 'ext', type: 'external', external: { url: 'https://cdn/x.jpg' } },
        ],
      },
      'Time Zone': { type: 'select', select: { name: 'Europe/Berlin' } },
      'Postelyo Status': { type: 'select', select: { name: 'Scheduled' } },
      'Postelyo Note': { type: 'rich_text', rich_text: [rt('ok')] },
      'Published URL': { type: 'url', url: null },
      'Published At': { type: 'date', date: null },
      'Postelyo ID': { type: 'rich_text', rich_text: [] },
      ...overrides,
    },
  };
}

describe('mapPage', () => {
  it('reads Status from a select property as well as a status property', () => {
    const s = mapPage(page({ Status: { type: 'select', select: { name: 'Ready' } } }), {});
    expect(s.sourceStatus).toBe('Ready');
    const empty = mapPage(page({ Status: { type: 'select', select: null } }), {});
    expect(empty.sourceStatus).toBeNull();
  });

  it('maps contract properties using the property map', () => {
    const p = page({ 'post text': { type: 'rich_text', rich_text: [rt('lower')] } });
    const s = mapPage(p, { 'Post Text': 'post text' });
    expect(s).toMatchObject({
      externalId: 'page-1',
      title: 'Launch post',
      sourceStatus: 'Scheduled',
      publishDate: { start: '2026-10-01T09:00:00.000+02:00', timeZone: null },
      platforms: ['LinkedIn'],
      timeZone: 'Europe/Berlin',
      system: {
        postelyoStatus: 'Scheduled',
        postelyoNote: 'ok',
        publishedUrl: null,
        publishedAt: null,
        postelyoId: '',
      },
    });
    expect(s.media).toEqual([
      { name: 'hero.png', url: 'https://s3/hero.png?sig=1', kind: 'file' },
      { name: 'ext', url: 'https://cdn/x.jpg', kind: 'external' },
    ]);
    expect(s.postText).toEqual([rt('lower')]);
  });

  it('tolerates empty and missing properties', () => {
    const s = mapPage(
      page({
        Name: { type: 'title', title: [] },
        Status: { type: 'status', status: null },
        'Publish Date': { type: 'date', date: null },
        Platforms: { type: 'multi_select', multi_select: [] },
        Media: { type: 'files', files: [] },
        'Time Zone': { type: 'rich_text', rich_text: [] },
      }),
      {},
    );
    expect(s.title).toBe('Untitled');
    expect(s.sourceStatus).toBeNull();
    expect(s.publishDate).toBeNull();
    expect(s.platforms).toEqual([]);
    expect(s.timeZone).toBeNull();
  });
});

describe('richTextToInlines', () => {
  it('keeps links, bold/italic and mentions', () => {
    expect(
      richTextToInlines([
        rt('Hello '),
        rt('bold', { annotations: { bold: true, italic: true } }),
        rt('site', { href: 'https://x.y' }),
        { type: 'mention', plain_text: '@Alice', href: null },
        rt(''),
      ]),
    ).toEqual([
      { t: 'text', text: 'Hello ' },
      { t: 'text', text: 'bold', marks: ['bold', 'italic'] },
      { t: 'link', text: 'site', href: 'https://x.y' },
      { t: 'mention', text: '@Alice' },
    ]);
  });
});

describe('blocksToCanonical', () => {
  const block = (type: string, text: string, hasChildren = false): NotionBlock => ({
    id: type,
    type,
    hasChildren,
    value: { rich_text: [rt(text)] },
  });

  it('collapses list items, bolds headings, flattens unknown blocks with warnings', () => {
    const r = blocksToCanonical([
      block('heading_2', 'Title'),
      block('paragraph', 'Body'),
      block('bulleted_list_item', 'one'),
      block('bulleted_list_item', 'two'),
      block('numbered_list_item', 'first'),
      block('divider', ''),
      block('toggle', 'hidden', true),
      { id: 'img', type: 'image', hasChildren: false, value: {} },
    ]);
    expect(r.blocks).toEqual([
      { type: 'paragraph', inlines: [{ t: 'text', text: 'Title', marks: ['bold'] }] },
      { type: 'paragraph', inlines: [{ t: 'text', text: 'Body' }] },
      {
        type: 'bulleted_list',
        items: [[{ t: 'text', text: 'one' }], [{ t: 'text', text: 'two' }]],
      },
      { type: 'numbered_list', items: [[{ t: 'text', text: 'first' }]] },
      { type: 'paragraph', inlines: [{ t: 'text', text: 'hidden' }] },
    ]);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"toggle" was flattened'),
        expect.stringContaining('Nested content inside a "toggle"'),
        expect.stringContaining('"image" was skipped'),
      ]),
    );
  });
});

describe('buildCanonicalContent', () => {
  it('prefers the body and falls back to Post Text split on blank lines', () => {
    const src = mapPage(page(), {});
    const withBody = buildCanonicalContent({
      page: src,
      bodyBlocks: [
        { id: 'p', type: 'paragraph', hasChildren: false, value: { rich_text: [rt('From body')] } },
      ],
      mediaAssetIds: ['m1', 'm2'],
    });
    expect(withBody.content.blocks).toEqual([
      { type: 'paragraph', inlines: [{ t: 'text', text: 'From body' }] },
    ]);
    expect(withBody.content.media).toEqual([
      { assetId: 'm1', kind: 'image', alt: 'hero.png' },
      { assetId: 'm2', kind: 'image', alt: 'ext' },
    ]);
    expect(withBody.hash).toMatch(/^[0-9a-f]{64}$/);

    const fallback = buildCanonicalContent({
      page: mapPage(
        page({
          'Post Text': { type: 'rich_text', rich_text: [rt('Para one\n\nPara two\nsame para')] },
        }),
        {},
      ),
      bodyBlocks: [],
      mediaAssetIds: ['m1', 'm2'],
    });
    expect(fallback.content.blocks).toEqual([
      { type: 'paragraph', inlines: [{ t: 'text', text: 'Para one' }] },
      { type: 'paragraph', inlines: [{ t: 'text', text: 'Para two\nsame para' }] },
    ]);
    expect(fallback.plainLength).toBe('Para one'.length + 'Para two\nsame para'.length);
    expect(fallback.hash).not.toBe(withBody.hash);
  });
});
