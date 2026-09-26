import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(databaseUrl: string, opts: { max?: number } = {}) {
  const sql = postgres(databaseUrl, {
    max: opts.max ?? 10,
    // Keep dates as Date objects; timestamptz columns are the only timestamps we use.
    prepare: true,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return {
    db,
    sql,
    /** Cheap readiness probe used by /health/ready. */
    ping: async (): Promise<boolean> => {
      const rows = await sql`select 1 as ok`;
      return rows.length === 1;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
