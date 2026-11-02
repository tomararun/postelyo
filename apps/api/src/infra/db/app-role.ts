import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * The application connects as a restricted role: superusers bypass row-level
 * security, so running the app as the database owner would silently disable
 * tenant isolation (security.md §4.2, preflight "database role"). Migrations run
 * as the owner; this creates or refreshes the app role and returns its URL.
 * Used by the integration tests and by `npm run dev:db`.
 */
export const APP_ROLE = 'postelyo_app';
export const APP_ROLE_PASSWORD = 'postelyo_app';

export async function ensureAppRole(db: Db, ownerUrl: string): Promise<string> {
  const dbName = new URL(ownerUrl).pathname.replace(/^\//, '');
  const exists = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from pg_roles where rolname = ${APP_ROLE}`,
  );
  if (Number([...exists][0]?.n ?? 0) === 0) {
    await db.execute(
      sql.raw(
        `create role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}' nosuperuser nobypassrls`,
      ),
    );
  }
  await db.execute(sql.raw(`grant connect, create, temp on database "${dbName}" to ${APP_ROLE}`));
  for (const schema of ['public', 'drizzle']) {
    await db.execute(sql.raw(`grant usage on schema ${schema} to ${APP_ROLE}`));
    await db.execute(sql.raw(`grant all on all tables in schema ${schema} to ${APP_ROLE}`));
    await db.execute(sql.raw(`grant all on all sequences in schema ${schema} to ${APP_ROLE}`));
    await db.execute(
      sql.raw(`alter default privileges in schema ${schema} grant all on tables to ${APP_ROLE}`),
    );
  }
  const u = new URL(ownerUrl);
  u.username = APP_ROLE;
  u.password = APP_ROLE_PASSWORD;
  return u.toString();
}
