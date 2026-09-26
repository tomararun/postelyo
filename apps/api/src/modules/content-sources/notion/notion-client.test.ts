import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../../shared/fetch-utils.js';
import { NOTION_VERSION, NotionApiError, NotionClient } from './notion-client.js';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('NotionClient.retrieveDatabase', () => {
  it('sends auth and version headers and normalises properties', async () => {
    let seen: Record<string, string> = {};
    const client = new NotionClient('ntn_secret', {
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toBe('https://api.notion.com/v1/databases/db-1');
        seen = init.headers as Record<string, string>;
        return json(200, {
          object: 'database',
          id: 'db-1',
          title: [{ plain_text: 'Content ' }, { plain_text: 'Calendar' }],
          properties: {
            Name: { id: 'title', type: 'title', title: {} },
            Status: {
              id: 'st',
              type: 'status',
              status: { options: [{ name: 'Draft' }, { name: 'Ready' }], groups: [] },
            },
            Platforms: {
              id: 'pl',
              type: 'multi_select',
              multi_select: { options: [{ name: 'LinkedIn' }] },
            },
          },
        });
      }),
    });
    const db = await client.retrieveDatabase('db-1');
    expect(seen['authorization']).toBe('Bearer ntn_secret');
    expect(seen['notion-version']).toBe(NOTION_VERSION);
    expect(db.title).toBe('Content Calendar');
    expect(db.properties['Status']).toEqual({
      id: 'st',
      name: 'Status',
      type: 'status',
      options: [{ name: 'Draft' }, { name: 'Ready' }],
    });
    expect(db.properties['Name']?.options).toBeUndefined();
  });

  it('maps error statuses to typed codes', async () => {
    const cases: [number, string, Record<string, string>?][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'not_found'],
      [429, 'rate_limited', { 'retry-after': '2' }],
      [400, 'invalid_request'],
      [503, 'unavailable'],
    ];
    for (const [status, code, headers] of cases) {
      const client = new NotionClient('t', {
        fetchImpl: fakeFetch(() => json(status, { message: 'boom' }, headers)),
      });
      const err = await client.retrieveDatabase('x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotionApiError);
      expect((err as NotionApiError).code, `status ${status}`).toBe(code);
      if (status === 429) expect((err as NotionApiError).retryAfterMs).toBe(2000);
    }
  });

  it('maps network failures', async () => {
    const client = new NotionClient('t', {
      fetchImpl: fakeFetch(() => {
        throw new Error('ENOTFOUND');
      }),
    });
    await expect(client.retrieveDatabase('x')).rejects.toMatchObject({ code: 'network' });
  });
});
