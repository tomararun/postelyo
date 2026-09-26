import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Row-level security scope (architecture §4 item 7, security.md §4.2).
 *
 * Every tenant-owned table carries a policy that admits a row only when
 * `app.workspace_id` is unset (system scope: jobs that iterate workspaces) or
 * equals the row's `workspace_id`. `withTenantScope` runs `fn` in a transaction
 * with the setting bound to one workspace, so a query that forgets its
 * `WHERE workspace_id = …` still cannot read or write another tenant's rows.
 *
 * Repositories remain the first line of defence; this is the second.
 */

/** Postgres GUC read by the policies. */
export const TENANT_SETTING = 'app.workspace_id';

/** A transaction handle; the same query API as `Db` (select/insert/update/delete/execute/transaction). */
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function withTenantScope<T>(
  db: Db,
  workspaceId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // `true` = local to this transaction; the pooled connection is clean afterwards.
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${workspaceId}, true)`);
    return fn(tx);
  });
}

/** Tables protected by a workspace policy; preflight and tests check that RLS is forced on each. */
export const RLS_TABLES = [
  'workspace',
  'membership',
  'invitation',
  'billing_customer',
  'subscription',
  'social_account',
  'oauth_state',
  'content_source',
  'post',
  'publication',
  'publish_attempt',
  'media_asset',
  'media_object',
  'webhook_event',
  'campaign',
  'approval',
  'short_link',
  'publication_metric',
  'audit_log',
] as const;
