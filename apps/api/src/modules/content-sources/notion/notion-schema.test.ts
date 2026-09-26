import { describe, expect, it } from 'vitest';
import type { NotionDatabase, NotionProperty } from './notion-client.js';
import { parseNotionDatabaseId, validateNotionDatabase } from './notion-schema.js';

function prop(name: string, type: string, options?: string[]): NotionProperty {
  return {
    id: name,
    name,
    type,
    ...(options ? { options: options.map((n) => ({ name: n })) } : {}),
  };
}

export function templateDatabase(
  overrides: Partial<Record<string, NotionProperty | null>> = {},
): NotionDatabase {
  const base: Record<string, NotionProperty> = {
    Name: prop('Name', 'title'),
    Status: prop('Status', 'status', [
      'Idea',
      'Draft',
      'In review',
      'Changes requested',
      'Ready',
      'Scheduled',
      'Cancelled',
    ]),
    'Publish Date': prop('Publish Date', 'date'),
    Platforms: prop('Platforms', 'multi_select', [
      'LinkedIn',
      'LinkedIn Page',
      'X',
      'Facebook Page',
      'Instagram',
    ]),
    'Post Text': prop('Post Text', 'rich_text'),
    Media: prop('Media', 'files'),
    'Time Zone': prop('Time Zone', 'select', []),
    'Postelyo Status': prop('Postelyo Status', 'select', []),
    'Postelyo Note': prop('Postelyo Note', 'rich_text'),
    'Published URL': prop('Published URL', 'url'),
    'Published At': prop('Published At', 'date'),
    'Postelyo ID': prop('Postelyo ID', 'rich_text'),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete base[k];
    else if (v) base[k] = v;
  }
  return { id: 'db', title: 'Content', properties: base };
}

describe('validateNotionDatabase', () => {
  it('accepts a select-typed Status (API-created template) with the same options', () => {
    const r = validateNotionDatabase(
      templateDatabase({
        Status: prop('Status', 'select', [
          'Idea',
          'Draft',
          'In review',
          'Changes requested',
          'Ready',
          'Scheduled',
          'Cancelled',
        ]),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('accepts the template database', () => {
    const r = validateNotionDatabase(templateDatabase());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.propertyMap['Publish Date']).toBe('Publish Date');
  });

  it('reports missing required properties, wrong types and missing options', () => {
    const r = validateNotionDatabase(
      templateDatabase({
        'Publish Date': null,
        'Postelyo Note': prop('Postelyo Note', 'select', []),
        Platforms: prop('Platforms', 'multi_select', ['Twitter']),
        Status: prop('Status', 'status', ['Draft', 'Scheduled']),
      }),
    );
    expect(r.ok).toBe(false);
    const codes = r.errors.map((e) => `${e.code}:${e.property}`).sort();
    expect(codes).toEqual([
      'MISSING_OPTION:Platforms',
      'MISSING_OPTION:Status',
      'MISSING_OPTION:Status',
      'MISSING_PROPERTY:Publish Date',
      'WRONG_TYPE:Postelyo Note',
    ]);
    expect(r.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Idea"'),
        expect.stringContaining('"In review"'),
      ]),
    );
  });

  it('matches property names case-insensitively and treats optional ones as warnings', () => {
    const r = validateNotionDatabase(
      templateDatabase({
        Media: null,
        'Time Zone': null,
        'Post Text': prop('post text', 'rich_text'),
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.propertyMap['Post Text']).toBe('post text');
    expect(r.warnings.map((w) => w.property).sort()).toEqual(['Media', 'Time Zone']);
  });
});

describe('parseNotionDatabaseId', () => {
  const id = '1f2e3d4c5b6a47f8a9b0c1d2e3f40506';
  const dashed = '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40506';

  it('accepts raw, dashed and url forms', () => {
    expect(parseNotionDatabaseId(id)).toBe(dashed);
    expect(parseNotionDatabaseId(dashed.toUpperCase())).toBe(dashed);
    expect(
      parseNotionDatabaseId(
        `https://www.notion.so/acme/Content-${id}?v=0a1b2c3d4e5f60718293a4b5c6d7e8f9`,
      ),
    ).toBe(dashed);
    expect(parseNotionDatabaseId(`  https://notion.so/${id}  `)).toBe(dashed);
  });

  it('rejects garbage', () => {
    expect(parseNotionDatabaseId('')).toBeNull();
    expect(parseNotionDatabaseId('not-an-id')).toBeNull();
    expect(parseNotionDatabaseId('https://www.notion.so/acme/Content')).toBeNull();
    expect(parseNotionDatabaseId(id.slice(0, 31))).toBeNull();
  });
});
