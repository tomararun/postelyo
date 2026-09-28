import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { auditLog, auditLogArchive, type AuditLogRow } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 7 audit export and archiving. Export streams a workspace's audit rows
 * as NDJSON for a date range (admins, and the public API). Archiving moves
 * rows older than the retention window into `audit_log_archive` in batches so
 * the hot table stays small; native partitioning is the later step
 * (architecture §20).
 */

export const AUDIT_HOT_MONTHS = 13;
export const AUDIT_ARCHIVE_BATCH = 5000;
/** Rows per export call; callers page with `after`. */
export const AUDIT_EXPORT_PAGE = 1000;

export interface AuditExportRow {
  id: string;
  occurredAt: string;
  actor: { type: string; id: string | null };
  entityType: string;
  entityId: string;
  event: string;
  fromState: string | null;
  toState: string | null;
  correlationId: string | null;
  data: unknown;
}

export interface AuditArchiveDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

export class AuditArchiveService {
  constructor(private readonly deps: AuditArchiveDeps) {}

  /** Newest first, filtered; for the public API and dashboards. */
  async list(
    ctx: TenantContext,
    filter: {
      since?: Date | undefined;
      events?: string[] | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<AuditExportRow[]> {
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, ctx.workspaceId),
            ...(filter.since ? [gte(auditLog.occurredAt, filter.since)] : []),
            ...(filter.events && filter.events.length > 0
              ? [inArray(auditLog.event, filter.events)]
              : []),
          ),
        )
        .orderBy(desc(auditLog.id))
        .limit(limit),
    );
    return rows.map(toExportRow);
  }

  /**
   * Pages through the range oldest first (hot table, then the archive for old
   * ranges). Audits the export once per call.
   */
  async *export(
    ctx: TenantContext,
    range: { from: Date; to: Date },
  ): AsyncGenerator<AuditExportRow, void, undefined> {
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      event: 'audit.exported',
      correlationId: ctx.correlationId,
      data: { from: range.from.toISOString(), to: range.to.toISOString() },
    });
    for (const table of [auditLogArchive, auditLog] as const) {
      let after: string | null = null;
      for (;;) {
        const rows: AuditLogRow[] = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
          tx
            .select({
              id: table.id,
              workspaceId: table.workspaceId,
              occurredAt: table.occurredAt,
              actorType: table.actorType,
              actorId: table.actorId,
              entityType: table.entityType,
              entityId: table.entityId,
              event: table.event,
              fromState: table.fromState,
              toState: table.toState,
              correlationId: table.correlationId,
              data: table.data,
            })
            .from(table)
            .where(
              and(
                eq(table.workspaceId, ctx.workspaceId),
                gte(table.occurredAt, range.from),
                lte(table.occurredAt, range.to),
                ...(after ? [sql`${table.id} > ${after}`] : []),
              ),
            )
            .orderBy(asc(table.id))
            .limit(AUDIT_EXPORT_PAGE),
        );
        for (const r of rows) yield toExportRow(r);
        if (rows.length < AUDIT_EXPORT_PAGE) break;
        after = rows.at(-1)!.id;
      }
    }
  }

  /** Maintenance: moves one batch of rows older than the hot window; returns how many. */
  async archive(correlationId: string): Promise<number> {
    const cutoff = new Date(this.deps.clock.now());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - AUDIT_HOT_MONTHS);
    const moved = await this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(auditLog)
        .where(lt(auditLog.occurredAt, cutoff))
        .orderBy(asc(auditLog.id))
        .limit(AUDIT_ARCHIVE_BATCH);
      if (rows.length === 0) return 0;
      await tx
        .insert(auditLogArchive)
        .values(
          rows.map((r) => ({
            id: r.id,
            workspaceId: r.workspaceId,
            occurredAt: r.occurredAt,
            actorType: r.actorType,
            actorId: r.actorId,
            entityType: r.entityType,
            entityId: r.entityId,
            event: r.event,
            fromState: r.fromState,
            toState: r.toState,
            correlationId: r.correlationId,
            data: r.data,
          })),
        )
        .onConflictDoNothing();
      await tx.delete(auditLog).where(
        inArray(
          auditLog.id,
          rows.map((r) => r.id),
        ),
      );
      return rows.length;
    });
    if (moved > 0) {
      await recordAudit(this.deps.db, {
        workspaceId: null,
        actor: { type: 'system', id: 'maintenance' },
        entityType: 'worker',
        entityId: 'audit-archive',
        event: 'audit.archived',
        correlationId,
        data: { rows: moved, before: cutoff.toISOString() },
      });
      this.deps.logger.info({ moved, cutoff, correlationId }, 'audit rows archived');
    }
    return moved;
  }
}

function toExportRow(r: AuditLogRow): AuditExportRow {
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    actor: { type: r.actorType, id: r.actorId },
    entityType: r.entityType,
    entityId: r.entityId,
    event: r.event,
    fromState: r.fromState,
    toState: r.toState,
    correlationId: r.correlationId,
    data: r.data,
  };
}
