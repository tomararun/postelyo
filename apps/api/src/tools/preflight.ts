import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { loadEnv, type Env } from '../config/env.js';
import { parseEncryptionKeys } from '../infra/crypto/key-provider.js';
import { createDb, type Db } from '../infra/db/client.js';
import { RLS_TABLES } from '../infra/db/tenant-scope.js';
import { HeartbeatService } from '../modules/ops/heartbeat.service.js';
import { systemClock } from '../shared/clock.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightDeps {
  env: Env;
  db: Db;
  heartbeat: HeartbeatService;
  /** Folder containing drizzle migrations (with meta/_journal.json). */
  migrationsDir: string;
}

/**
 * Go-live checks for an environment (docs/pilot-checklist.md). Read-only; safe
 * to run against production. Exit code 1 when anything fails.
 */
export async function runPreflight(deps: PreflightDeps): Promise<Check[]> {
  const { env, db } = deps;
  const checks: Check[] = [];
  const prod = env.NODE_ENV === 'production';
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ name, status, detail });

  // Configuration
  try {
    const keys = parseEncryptionKeys(env.ENCRYPTION_KEYS);
    add('encryption keys', 'pass', `${keys.length} key(s), current "${keys[0]!.id}"`);
  } catch (err) {
    add('encryption keys', 'fail', (err as Error).message);
  }
  add(
    'app base url',
    env.APP_BASE_URL.startsWith('https://') ? 'pass' : prod ? 'fail' : 'warn',
    env.APP_BASE_URL,
  );
  add(
    'provider mode',
    env.PROVIDER_MODE === 'live' ? 'pass' : prod ? 'fail' : 'warn',
    env.PROVIDER_MODE === 'live'
      ? 'live: posts go to LinkedIn'
      : 'fake: nothing is sent to LinkedIn',
  );
  add(
    'linkedin app',
    env.LINKEDIN_CLIENT_ID ? 'pass' : prod ? 'fail' : 'warn',
    env.LINKEDIN_CLIENT_ID
      ? 'client id configured'
      : 'LINKEDIN_CLIENT_ID missing; connect button disabled',
  );
  add(
    'alert email',
    env.ALERT_EMAIL ? 'pass' : prod ? 'fail' : 'warn',
    env.ALERT_EMAIL ?? 'ALERT_EMAIL missing; alerts only logged',
  );
  add(
    'mail transport',
    env.MAIL_TRANSPORT === 'smtp' ? 'pass' : prod ? 'fail' : 'warn',
    env.MAIL_TRANSPORT === 'smtp'
      ? `smtp (${new URL(env.SMTP_URL ?? 'smtp://unset').host})`
      : 'log transport: emails are only logged',
  );
  add(
    'metrics token',
    env.METRICS_TOKEN ? 'pass' : 'warn',
    env.METRICS_TOKEN ? 'set' : '/metrics is unauthenticated',
  );
  add(
    'error reporting',
    env.SENTRY_DSN ? 'pass' : 'warn',
    env.SENTRY_DSN ? 'Sentry configured' : 'SENTRY_DSN missing',
  );
  add(
    'notion webhooks',
    env.NOTION_WEBHOOK_SECRET ? 'pass' : 'warn',
    env.NOTION_WEBHOOK_SECRET
      ? 'secret set; enable per workspace with notionWebhooks=true'
      : 'NOTION_WEBHOOK_SECRET missing; inbound webhooks ignored, polling only',
  );

  // Database
  let dbOk = false;
  try {
    const rows = await db.execute<{ version: string }>(sql`select version() as version`);
    const version = [...rows][0]?.version ?? 'unknown';
    add('database', 'pass', version.split(',')[0] ?? version);
    dbOk = true;
  } catch (err) {
    add('database', 'fail', `cannot connect: ${(err as Error).message}`);
  }
  if (dbOk) {
    try {
      const journal = JSON.parse(
        readFileSync(path.join(deps.migrationsDir, 'meta', '_journal.json'), 'utf8'),
      ) as {
        entries: unknown[];
      };
      const applied = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from drizzle.__drizzle_migrations`,
      );
      const appliedN = Number([...applied][0]?.n ?? 0);
      const localN = journal.entries.length;
      add(
        'migrations',
        appliedN === localN ? 'pass' : appliedN < localN ? 'fail' : 'warn',
        `${appliedN} applied, ${localN} in repository${appliedN < localN ? ' — run db:migrate' : ''}`,
      );
    } catch (err) {
      add('migrations', 'fail', `cannot read migration state: ${(err as Error).message}`);
    }
    try {
      const schemas = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from information_schema.schemata where schema_name = 'pgboss'`,
      );
      add(
        'job queue schema',
        Number([...schemas][0]?.n ?? 0) > 0 ? 'pass' : 'warn',
        Number([...schemas][0]?.n ?? 0) > 0
          ? 'pgboss schema present'
          : 'pgboss schema missing until the worker starts once',
      );
    } catch (err) {
      add('job queue schema', 'fail', (err as Error).message);
    }
    // Row-level security only protects when the app role is subject to it.
    try {
      const role = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; name: string }>(
        sql`select rolname as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      );
      const r = [...role][0];
      const bypasses = r?.rolsuper === true || r?.rolbypassrls === true;
      add(
        'database role',
        bypasses ? (prod ? 'fail' : 'warn') : 'pass',
        bypasses
          ? `"${r?.name}" is a superuser or has BYPASSRLS; row-level security is not enforced for the app`
          : `"${r?.name}" is subject to row-level security`,
      );
      const rls = await db.execute<{ name: string; forced: boolean }>(sql`
        select c.relname as name, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`);
      const forced = new Set([...rls].filter((t) => t.forced).map((t) => t.name));
      const missing = RLS_TABLES.filter((t) => !forced.has(t));
      add(
        'row level security',
        missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0
          ? `forced on ${RLS_TABLES.length} tenant tables`
          : `not forced on: ${missing.join(', ')} (run db:migrate)`,
      );
    } catch (err) {
      add('row level security', 'fail', (err as Error).message);
    }
    const age = await deps.heartbeat.latestAgeSeconds();
    add(
      'worker heartbeat',
      age === null ? (prod ? 'fail' : 'warn') : age < 120 ? 'pass' : 'fail',
      age === null ? 'no worker has ever reported' : `last seen ${age}s ago`,
    );
    const counts = await db.execute<{ workspaces: string; sources: string; accounts: string }>(sql`
      select
        (select count(*)::text from workspace where deleted_at is null) as workspaces,
        (select count(*)::text from content_source where status = 'active' and disconnected_at is null) as sources,
        (select count(*)::text from social_account where status = 'active' and disconnected_at is null) as accounts`);
    const c = [...counts][0];
    add(
      'tenants',
      'pass',
      `${c?.workspaces ?? 0} workspace(s), ${c?.sources ?? 0} active Notion source(s), ${c?.accounts ?? 0} active LinkedIn account(s)`,
    );
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${icon[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`).join('\n');
}

async function main(): Promise<void> {
  const env = loadEnv();
  const database = createDb(env.DATABASE_URL, { max: 1 });
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');
  try {
    const checks = await runPreflight({
      env,
      db: database.db,
      heartbeat: new HeartbeatService(database.db, systemClock),
      migrationsDir,
    });
    console.log(formatChecks(checks));
    const failed = checks.filter((c) => c.status === 'fail').length;
    console.log(
      `\n${failed === 0 ? 'Preflight passed' : `Preflight failed: ${failed} check(s)`}${checks.some((c) => c.status === 'warn') ? ' (with warnings)' : ''}.`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await database.close();
  }
}

if (process.argv[1] && /preflight\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
