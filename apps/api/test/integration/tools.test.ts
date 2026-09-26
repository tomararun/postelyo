import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createNotionTemplate } from '../../src/tools/create-notion-template.js';
import { formatChecks, runPreflight } from '../../src/tools/preflight.js';
import { NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, testEnv, uniqueEmail, type TestStack } from './helpers.js';

describe('pilot tooling', () => {
  let stack: TestStack;
  const fake = createFakeProviders();

  beforeAll(async () => {
    stack = await createTestStack({ fetchImpl: fake.fetchImpl });
  });
  afterAll(async () => {
    await stack.close();
  });

  it('creates a Notion template database that passes contract validation and can be connected', async () => {
    const result = await createNotionTemplate({
      token: NOTION_VALID_TOKEN,
      parentPage: 'https://www.notion.so/acme/Marketing-1f2e3d4c5b6a47f8a9b0c1d2e3f40507',
      fetchImpl: fake.fetchImpl,
    });
    expect(result.validation.ok).toBe(true);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.warnings).toEqual([]);
    expect(result.url).toContain('notion.so');

    // The suite creates Campaigns and Ideas first, then the content database; relations follow by PATCH.
    const creates = fake.requests.filter(
      (r) => r.url.endsWith('/v1/databases') && r.method === 'POST',
    );
    const create = creates.find((r) => r.body.includes('"Postelyo Content"'));
    const body = JSON.parse(create!.body) as {
      parent: { page_id: string };
      properties: Record<string, unknown>;
    };
    expect(body.parent.page_id).toBe('1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40507');
    expect(creates.some((r) => r.body.includes('"Postelyo Campaigns"'))).toBe(true);
    expect(creates.some((r) => r.body.includes('"Postelyo Ideas"'))).toBe(true);
    const relations = fake.requests.find(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/v1/databases/${result.databaseId}`),
    );
    expect(relations).toBeDefined();
    expect(
      Object.keys((JSON.parse(relations!.body) as { properties: object }).properties).sort(),
    ).toEqual(['Campaign', 'Repeat Of']);
    expect(Object.keys(body.properties).sort()).toEqual(
      [
        'Media',
        'Name',
        'Platforms',
        'Post Text',
        'Postelyo ID',
        'Postelyo Note',
        'Postelyo Status',
        'Publish Date',
        'Published At',
        'Published URL',
        'Published URLs',
        'LinkedIn Text',
        'X Text',
        'Facebook Text',
        'Instagram Caption',
        'Status',
        'Time Zone',
        // Phase 4 (template v2); relations are added after creation
        'Repeat',
        'Repeat Until',
        'First Comment',
        'Approval',
        'Link Report',
      ].sort(),
    );

    // The generated database connects like any other.
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('tmpl'));
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: result.url },
    });
    expect(connect.statusCode).toBe(201);
    expect(connect.json()).toMatchObject({ databaseTitle: 'Postelyo Content', warnings: [] });
  });

  it('rejects an unusable parent reference before calling Notion', async () => {
    await expect(
      createNotionTemplate({
        token: NOTION_VALID_TOKEN,
        parentPage: 'nope',
        fetchImpl: fake.fetchImpl,
      }),
    ).rejects.toThrow(/parent page/);
  });

  it('runs preflight checks against the environment and reports warnings and failures', async () => {
    const migrationsDir = path.resolve(process.cwd(), 'drizzle');
    const before = await runPreflight({
      env: testEnv,
      db: stack.db.db,
      heartbeat: stack.services.heartbeat,
      migrationsDir,
    });
    const byName = Object.fromEntries(before.map((c) => [c.name, c]));
    expect(byName['database']?.status).toBe('pass');
    expect(byName['migrations']?.status).toBe('pass');
    expect(byName['encryption keys']?.status).toBe('pass');
    expect(byName['provider mode']?.status).toBe('warn');
    expect(byName['mail transport']?.status).toBe('warn');
    expect(byName['alert email']?.status).toBe('pass');
    expect(['warn', 'pass']).toContain(byName['worker heartbeat']?.status);
    expect(byName['tenants']?.detail).toMatch(/\d+ workspace\(s\)/);

    // Production is stricter: fake mode and log mail become failures.
    const prod = await runPreflight({
      env: { ...testEnv, NODE_ENV: 'production' },
      db: stack.db.db,
      heartbeat: stack.services.heartbeat,
      migrationsDir,
    });
    const prodByName = Object.fromEntries(prod.map((c) => [c.name, c]));
    expect(prodByName['provider mode']?.status).toBe('fail');
    expect(prodByName['mail transport']?.status).toBe('fail');
    expect(prodByName['app base url']?.status).toBe('fail');

    await stack.services.heartbeat.beat('preflight-worker', new Date(), 'test');
    const after = await runPreflight({
      env: testEnv,
      db: stack.db.db,
      heartbeat: stack.services.heartbeat,
      migrationsDir,
    });
    expect(after.find((c) => c.name === 'worker heartbeat')?.status).toBe('pass');

    const text = formatChecks(after);
    expect(text).toMatch(/^PASS {2}database/m);
    expect(text).toMatch(/WARN {2}provider mode/);
  });
});
