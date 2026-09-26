import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../../config/env.js';
import { createLogger } from '../logger.js';
import { createDb } from './client.js';

/**
 * Applies pending migrations from apps/api/drizzle. Run as a one-off job before
 * deploying a new image (architecture §18.1). Migrations are expand/contract.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'worker').child({ job: 'migrate' });
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../drizzle',
  );
  logger.info({ migrationsFolder }, 'applying migrations');
  try {
    await migrate(db, { migrationsFolder });
    logger.info('migrations applied');
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
