import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

/**
 * Phase 7 restore drill (runbook "Restore drill"): dumps the source database,
 * restores it into an empty drill database, and checks that the restored copy
 * holds the same row counts for the tables that matter. Run it monthly (CI or
 * cron) so a real restore is never the first one.
 *
 *   DATABASE_URL=postgres://…/postelyo DRILL_TARGET_DATABASE_URL=postgres://…/postelyo_drill \
 *     npm run restore:drill --workspace apps/api
 *
 * Requires `pg_dump` and `pg_restore` on PATH. The target database must exist
 * and be empty; the script refuses to touch a target that already has tables.
 */

const run = promisify(execFile);

const CHECK_TABLES = [
  'workspace',
  'membership',
  'social_account',
  'content_source',
  'post',
  'publication',
  'audit_log',
  'api_key',
  'webhook_endpoint',
];

async function counts(url: string): Promise<Record<string, number>> {
  const sql = postgres(url, { max: 1 });
  try {
    const out: Record<string, number> = {};
    for (const t of CHECK_TABLES) {
      const [row] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from "${t}"`);
      out[t] = Number(row?.n ?? 0);
    }
    return out;
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const source = process.env['DATABASE_URL'];
  const target = process.env['DRILL_TARGET_DATABASE_URL'];
  if (!source || !target)
    throw new Error('DATABASE_URL and DRILL_TARGET_DATABASE_URL are required');
  if (source === target) throw new Error('source and target must differ');

  const targetSql = postgres(target, { max: 1 });
  const [existing] = await targetSql.unsafe<{ n: string }[]>(
    `select count(*)::text as n from information_schema.tables where table_schema = 'public'`,
  );
  await targetSql.end();
  if (Number(existing?.n ?? 0) > 0)
    throw new Error('target database is not empty; refusing to restore into it');

  const dir = await mkdtemp(path.join(tmpdir(), 'postelyo-drill-'));
  const dump = path.join(dir, 'postelyo.dump');
  const started = Date.now();
  try {
    console.log('dumping source…');
    await run(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, source],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const dumpedMs = Date.now() - started;
    console.log(`restoring into target… (dump took ${dumpedMs} ms)`);
    await run(
      'pg_restore',
      ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', target, dump],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const restoredMs = Date.now() - started - dumpedMs;
    const [before, after] = await Promise.all([counts(source), counts(target)]);
    const mismatches = CHECK_TABLES.filter((t) => before[t] !== after[t]);
    const report = {
      ok: mismatches.length === 0,
      dumpMs: dumpedMs,
      restoreMs: restoredMs,
      totalMs: Date.now() - started,
      tables: CHECK_TABLES.map((t) => ({ table: t, source: before[t], target: after[t] })),
      mismatches,
      drilledAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
      return;
    }
    console.log('restore drill passed; record the numbers in the runbook drill log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
