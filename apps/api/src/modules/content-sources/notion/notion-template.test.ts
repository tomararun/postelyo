import { describe, expect, it } from 'vitest';
import type { NotionDatabase, NotionProperty } from './notion-client.js';
import { NOTION_CONTRACT, validateNotionDatabase } from './notion-schema.js';
import {
  templateCoversContract,
  templateCreateBody,
  templateProperties,
} from './notion-template.js';

/** Turns the create-request property definitions into what Notion echoes back. */
function asDatabase(): NotionDatabase {
  const properties: Record<string, NotionProperty> = {};
  for (const [name, def] of Object.entries(templateProperties())) {
    const type = Object.keys(def as object)[0]!;
    const cfg = (def as Record<string, { options?: { name: string }[] }>)[type];
    properties[name] = {
      id: name,
      name,
      type,
      ...(cfg?.options ? { options: cfg.options.map((o) => ({ name: o.name })) } : {}),
    };
  }
  return { id: 'tmpl', title: 'Postelyo Content', properties };
}

describe('notion template', () => {
  it('covers every contract property and validates without errors or warnings', () => {
    expect(templateCoversContract()).toEqual([]);
    const r = validateNotionDatabase(asDatabase());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(Object.keys(r.propertyMap)).toHaveLength(NOTION_CONTRACT.length);
  });

  it('builds a create request under the given parent page', () => {
    const body = templateCreateBody('1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40507') as {
      parent: { type: string; page_id: string };
      title: { text: { content: string } }[];
      properties: Record<string, unknown>;
    };
    expect(body.parent).toEqual({
      type: 'page_id',
      page_id: '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40507',
    });
    expect(body.title[0]!.text.content).toBe('Postelyo Content');
    expect(body.properties['Status']).toMatchObject({
      select: {
        options: expect.arrayContaining([{ name: 'Scheduled', color: 'purple' }]) as unknown,
      },
    });
  });
});
