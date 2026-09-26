import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb } from '../../src/infra/db/client.js';
import { workspace } from '../../src/infra/db/schema.js';
import { uuidv7 } from '../../src/shared/ids.js';

/** Requires DATABASE_URL with migrations applied (npm run db:migrate). */
const url = process.env['DATABASE_URL'];

describe.skipIf(!url)('database', () => {
  const database = createDb(url ?? '', { max: 2 });

  beforeAll(async () => {
    expect(await database.ping()).toBe(true);
  });
  afterAll(async () => {
    await database.close();
  });

  it('round-trips a workspace row', async () => {
    const id = uuidv7();
    const slug = `it-${id.slice(0, 8)}`;
    await database.db
      .insert(workspace)
      .values({ id, slug, name: 'Integration', defaultTimezone: 'UTC' });
    const [row] = await database.db.select().from(workspace).where(eq(workspace.id, id));
    expect(row?.slug).toBe(slug);
    expect(row?.defaultPublishTime).toBe('09:00:00');
    expect(row?.settings).toEqual({ v: 1 });
    await database.db.delete(workspace).where(eq(workspace.id, id));
  });
});
