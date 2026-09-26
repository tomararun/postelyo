import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { TestProject } from 'vitest/node';
import { createDb } from '../../src/infra/db/client.js';

/**
 * Integration test database. Uses DATABASE_URL when set (CI); otherwise boots a
 * throwaway embedded Postgres so the suite runs on machines without Docker.
 * Migrations are applied either way, so tests always see the current schema.
 *
 * The application under test connects as a restricted role (`postelyo_app`):
 * superusers bypass row-level security, so testing tenancy as the owner would
 * prove nothing. The owner URL is kept for migrations only.
 */
const APP_ROLE = 'postelyo_app';
const APP_PASSWORD = 'postelyo_app';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env['DATABASE_URL'];
  let stop: (() => Promise<void>) | undefined;

  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = mkdtempSync(path.join(tmpdir(), 'postelyo-pg-'));
    const port = 54300 + Math.floor(Math.random() * 200);
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postelyo',
      password: 'postelyo',
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('postelyo_test');
    url = `postgres://postelyo:postelyo@127.0.0.1:${port}/postelyo_test`;
    stop = async () => {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }

  const database = createDb(url, { max: 1 });
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../drizzle',
  );
  await migrate(database.db, { migrationsFolder });
  const appUrl = await createAppRole(database.db, url);
  await database.close();

  process.env['DATABASE_URL'] = appUrl;
  project.provide('databaseUrl', appUrl);

  return async () => {
    await stop?.();
  };
}

/** Creates (or refreshes) the restricted app role and returns a connection URL for it. */
async function createAppRole(db: ReturnType<typeof createDb>['db'], ownerUrl: string) {
  const dbName = new URL(ownerUrl).pathname.replace(/^\//, '');
  const exists = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from pg_roles where rolname = ${APP_ROLE}`,
  );
  if (Number([...exists][0]?.n ?? 0) === 0) {
    await db.execute(
      sql.raw(`create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls`),
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
  u.password = APP_PASSWORD;
  return u.toString();
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
