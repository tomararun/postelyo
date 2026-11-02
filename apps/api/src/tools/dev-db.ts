import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { ensureAppRole } from '../infra/db/app-role.js';
import { createDb } from '../infra/db/client.js';

/**
 * Local Postgres without Docker: `npm run dev:db`.
 *
 * Starts a persistent embedded Postgres (data in `.devdata/pgdata` at the repo root,
 * git-ignored), applies every migration as the owner, creates the restricted app
 * role, prints the DATABASE_URL to put in `.env`, and keeps running until Ctrl+C.
 * Run it again any time: data is kept and new migrations are applied on start.
 *
 *   DEV_DB_PORT=5433 (default)   DEV_DB_DIR=<path> (default .devdata/pgdata)
 *
 * On Windows the bundled Postgres needs the Microsoft Visual C++ 2015-2022 x64
 * runtime (`winget install --id Microsoft.VCRedist.2015+.x64 -e`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const port = Number(process.env['DEV_DB_PORT'] ?? 5433);
const dataDir = path.resolve(
  process.env['DEV_DB_DIR'] ?? path.join(repoRoot, '.devdata', 'pgdata'),
);
const migrationsFolder = path.resolve(here, '../../drizzle');
const OWNER = { user: 'postelyo', password: 'postelyo' };
const DB_NAME = 'postelyo';

// Folders Postgres expects even when empty; temp-folder cleaners and some sync tools
// delete empty folders, after which Postgres refuses to start.
const EMPTY_DIRS = [
  'pg_notify',
  'pg_tblspc',
  'pg_snapshots',
  'pg_stat',
  'pg_stat_tmp',
  'pg_commit_ts',
  'pg_dynshmem',
  'pg_replslot',
  'pg_serial',
  'pg_twophase',
  'pg_logical/snapshots',
  'pg_logical/mappings',
  'pg_wal/archive_status',
  'pg_wal/summaries',
];

async function main(): Promise<void> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const fresh = !existsSync(path.join(dataDir, 'PG_VERSION'));
  if (!fresh) for (const d of EMPTY_DIRS) mkdirSync(path.join(dataDir, d), { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: OWNER.user,
    password: OWNER.password,
    port,
    persistent: true,
    onLog: () => {},
    onError: (e: unknown) => console.error('[postgres]', String(e)),
  });
  if (fresh) {
    console.log(`Creating a new database cluster in ${dataDir}…`);
    await pg.initialise();
  }
  await pg.start();
  if (fresh) await pg.createDatabase(DB_NAME);

  const ownerUrl = `postgres://${OWNER.user}:${OWNER.password}@127.0.0.1:${port}/${DB_NAME}`;
  const database = createDb(ownerUrl, { max: 1 });
  await migrate(database.db, { migrationsFolder });
  const appUrl = await ensureAppRole(database.db, ownerUrl);
  await database.close();

  console.log(`
Postgres is running on port ${port} with every migration applied.

  App connection (put this in .env):   DATABASE_URL=${appUrl}
  Owner connection (psql, migrations): ${ownerUrl}

The app uses the restricted role so row-level security is enforced. Keep this
terminal open; press Ctrl+C to stop. Data is kept in ${dataDir}.`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping Postgres…');
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  setInterval(() => {}, 1 << 30);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
