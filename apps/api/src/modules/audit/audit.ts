import { and, desc, eq } from 'drizzle-orm';
import { auditLog, type AuditLogRow } from '../../infra/db/schema.js';
import type { Db } from '../../infra/db/client.js';
import { uuidv7 } from '../../shared/ids.js';
import type { Actor } from '../tenancy/tenant-context.js';

/**
 * Append-only audit log (domain-model §2.10, security.md §9). Call inside the
 * same transaction as the state change it describes. Never put secrets or full
 * content in `data`.
 */

export type AuditEvent =
  | 'user.signed_in'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.deleted'
  | 'membership.created'
  | 'membership.role_changed'
  | 'membership.removed'
  | 'invitation.created'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'billing.checkout_started'
  | 'billing.plan_changed'
  | 'content_source.setup_completed'
  | 'social_account.connected'
  | 'social_account.reconnected'
  | 'social_account.disconnected'
  | 'social_account.status_changed'
  | 'social_account.token_refreshed'
  | 'content_source.connected'
  | 'content_source.updated'
  | 'content_source.disconnected'
  | 'content_source.synced'
  | 'content_source.sync_failed'
  | 'credential.accessed'
  | 'oauth.state_mismatch'
  | 'oauth.provider_error'
  | 'post.created'
  | 'post.source_status_observed'
  | 'post.snapshot_taken'
  | 'post.validation_failed'
  | 'post.archived'
  | 'post.state_changed'
  | 'publication.created'
  | 'publication.state_changed'
  | 'publication.rescheduled'
  | 'publication.deferred'
  | 'publication.reconciled'
  | 'publication.reconciliation_unresolved'
  | 'webhook.received'
  | 'alert.sent'
  | 'notification.sent';

export type AuditEntityType =
  | 'workspace'
  | 'membership'
  | 'user'
  | 'social_account'
  | 'content_source'
  | 'oauth_state'
  | 'post'
  | 'publication'
  | 'webhook_event'
  | 'alert'
  | 'worker';

export interface AuditEntry {
  workspaceId: string | null;
  actor: Actor;
  entityType: AuditEntityType;
  entityId: string;
  event: AuditEvent;
  fromState?: string | null;
  toState?: string | null;
  correlationId?: string | null;
  data?: Record<string, unknown>;
}

/** Accepts a Db or a transaction handle; both expose `insert`. */
export type AuditWriter = Pick<Db, 'insert'>;

/** Tenant-scoped audit trail for one entity, newest first (operator UI). */
export async function listAuditForEntity(
  db: Pick<Db, 'select'>,
  workspaceId: string,
  entityType: AuditEntityType,
  entityId: string,
  limit = 100,
): Promise<AuditLogRow[]> {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, workspaceId),
        eq(auditLog.entityType, entityType),
        eq(auditLog.entityId, entityId),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(limit);
}

const MAX_DATA_BYTES = 8 * 1024;

export async function recordAudit(db: AuditWriter, entry: AuditEntry): Promise<string> {
  const id = uuidv7();
  const data = entry.data ?? {};
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) {
    throw new Error(`audit data for ${entry.event} exceeds ${MAX_DATA_BYTES} bytes`);
  }
  await db.insert(auditLog).values({
    id,
    workspaceId: entry.workspaceId,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    event: entry.event,
    fromState: entry.fromState ?? null,
    toState: entry.toState ?? null,
    correlationId: entry.correlationId ?? null,
    data,
  });
  return id;
}
