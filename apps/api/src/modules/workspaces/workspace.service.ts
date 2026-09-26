import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { membership, workspace, type Membership, type Workspace } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { Role, TenantContext } from '../tenancy/tenant-context.js';
import {
  MAX_DAILY_CAP_PER_ACCOUNT,
  readSettings,
  type ApprovalSettings,
  type EvergreenSettings,
  type FlaggedProvider,
  type LinkSettings,
  type WorkspaceSettings,
} from './settings.js';
import { slugSuffix, workspaceDefaultsFromEmail } from './slug.js';
import { PUBLISH_TIME_RE, isValidTimeZone } from './timezone.js';

export class ValidationError extends Error {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    this.name = 'ValidationError';
  }
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

export interface WorkspacePatch {
  name?: string | undefined;
  defaultTimezone?: string | undefined;
  defaultPublishTime?: string | undefined;
  /** Posts per social account per rolling 24 h; null restores the default. */
  dailyCapPerAccount?: number | null | undefined;
  notionWebhooks?: boolean | undefined;
  /** Per-platform flags (Phase 2); merged into the existing map. */
  providers?: Partial<Record<FlaggedProvider, boolean | undefined>> | undefined;
  /** Phase 3 notification settings; null clears. */
  notificationEmail?: string | null | undefined;
  alertCopyEmail?: string | null | undefined;
  /** Phase 4: replaced wholesale when present; null clears. */
  links?: LinkSettings | null | undefined;
  evergreen?: EvergreenSettings | null | undefined;
  approval?: ApprovalSettings | null | undefined;
}

const DEFAULT_TIMEZONE = 'UTC';

/**
 * Workspace lifecycle and settings (architecture §4, PRD §4.1).
 * Reads and writes are always scoped by membership; there is no unscoped read.
 */
export class WorkspaceService {
  constructor(private readonly db: Db) {}

  /** Workspaces the user belongs to, with their role. */
  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
      .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)))
      .orderBy(workspace.createdAt);
    return rows;
  }

  /** Membership lookup used by the tenancy guard; null means "not a member" (→ 404). */
  async findMembership(userId: string, workspaceId: string): Promise<Membership | null> {
    // A soft-deleted workspace (Phase 3) is invisible: the purge job finishes it off.
    const [row] = await this.db
      .select({ m: membership })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
      .where(
        and(
          eq(membership.userId, userId),
          eq(membership.workspaceId, workspaceId),
          isNull(workspace.deletedAt),
        ),
      )
      .limit(1);
    return row?.m ?? null;
  }

  /** Tenant-scoped read. */
  async get(ctx: TenantContext): Promise<Workspace> {
    const [row] = await withTenantScope(this.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(workspace)
        .where(and(eq(workspace.id, ctx.workspaceId), isNull(workspace.deletedAt)))
        .limit(1),
    );
    if (!row) throw new Error(`workspace ${ctx.workspaceId} not found for tenant context`);
    return row;
  }

  /**
   * Idempotently ensures a user has at least one workspace; creates a default
   * one with an `owner` membership on first sign-in (PRD §7.1).
   */
  async ensureDefaultWorkspace(
    user: { id: string; email: string },
    correlationId: string,
  ): Promise<Workspace> {
    const existing = await this.listForUser(user.id);
    const first = existing[0];
    if (first) {
      const [row] = await this.db.select().from(workspace).where(eq(workspace.id, first.id));
      if (row) return row;
    }
    const { name, slugBase } = workspaceDefaultsFromEmail(user.email);
    return this.create(
      { name, slugBase, defaultTimezone: DEFAULT_TIMEZONE },
      user.id,
      correlationId,
    );
  }

  async create(
    input: { name: string; slugBase: string; defaultTimezone: string },
    ownerUserId: string,
    correlationId: string,
  ): Promise<Workspace> {
    if (!isValidTimeZone(input.defaultTimezone)) {
      throw new ValidationError([{ path: 'defaultTimezone', message: 'unknown IANA time zone' }]);
    }
    const id = uuidv7();
    const actor = { type: 'user', id: ownerUserId, role: 'owner' } as const;
    return this.db.transaction(async (tx) => {
      let created: Workspace | undefined;
      for (let attempt = 0; attempt < 3 && !created; attempt++) {
        const slug = attempt === 0 ? input.slugBase : `${input.slugBase}-${slugSuffix()}`;
        const [row] = await tx
          .insert(workspace)
          .values({ id, slug, name: input.name, defaultTimezone: input.defaultTimezone })
          .onConflictDoNothing({ target: workspace.slug })
          .returning();
        created = row;
      }
      if (!created) throw new Error('could not allocate a unique workspace slug');
      const membershipId = uuidv7();
      await tx.insert(membership).values({
        id: membershipId,
        workspaceId: created.id,
        userId: ownerUserId,
        role: 'owner',
      });
      await recordAudit(tx, {
        workspaceId: created.id,
        actor,
        entityType: 'workspace',
        entityId: created.id,
        event: 'workspace.created',
        correlationId,
        data: { slug: created.slug, defaultTimezone: created.defaultTimezone },
      });
      await recordAudit(tx, {
        workspaceId: created.id,
        actor,
        entityType: 'membership',
        entityId: membershipId,
        event: 'membership.created',
        correlationId,
        data: { userId: ownerUserId, role: 'owner' },
      });
      return created;
    });
  }

  /** Tenant-scoped settings update; the guard has already checked the role. */
  async update(ctx: TenantContext, patch: WorkspacePatch): Promise<Workspace> {
    const issues: { path: string; message: string }[] = [];
    const values: Partial<typeof workspace.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 1 || name.length > 80)
        issues.push({ path: 'name', message: '1–80 characters' });
      else values.name = name;
    }
    if (patch.defaultTimezone !== undefined) {
      if (!isValidTimeZone(patch.defaultTimezone)) {
        issues.push({ path: 'defaultTimezone', message: 'unknown IANA time zone' });
      } else values.defaultTimezone = patch.defaultTimezone;
    }
    if (patch.defaultPublishTime !== undefined) {
      if (!PUBLISH_TIME_RE.test(patch.defaultPublishTime)) {
        issues.push({ path: 'defaultPublishTime', message: 'expected HH:MM (24h)' });
      } else values.defaultPublishTime = patch.defaultPublishTime;
    }
    if (patch.dailyCapPerAccount !== undefined && patch.dailyCapPerAccount !== null) {
      const cap = patch.dailyCapPerAccount;
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP_PER_ACCOUNT) {
        issues.push({
          path: 'dailyCapPerAccount',
          message: `integer between 1 and ${MAX_DAILY_CAP_PER_ACCOUNT}`,
        });
      }
    }
    for (const k of ['notificationEmail', 'alertCopyEmail'] as const) {
      const v = patch[k];
      if (typeof v === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
        issues.push({ path: k, message: 'must be an email address' });
      }
    }
    if (patch.evergreen) {
      for (const s of patch.evergreen.slots) {
        if (!Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7)
          issues.push({ path: 'evergreen.slots', message: 'weekday must be 1 (Mon) to 7 (Sun)' });
        if (!PUBLISH_TIME_RE.test(s.time))
          issues.push({ path: 'evergreen.slots', message: 'time must be HH:MM' });
      }
      if (patch.evergreen.minGapDays !== undefined) {
        const g = patch.evergreen.minGapDays;
        if (!Number.isInteger(g) || g < 1 || g > 365)
          issues.push({ path: 'evergreen.minGapDays', message: 'integer between 1 and 365' });
      }
    }
    if (patch.links?.utm) {
      for (const [k, v] of Object.entries(patch.links.utm)) {
        if (typeof v === 'string' && v.length > 100)
          issues.push({ path: `links.utm.${k}`, message: 'at most 100 characters' });
      }
    }
    if (issues.length > 0) throw new ValidationError(issues);

    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [before] = await tx
        .select()
        .from(workspace)
        .where(and(eq(workspace.id, ctx.workspaceId), isNull(workspace.deletedAt)))
        .limit(1)
        .for('update');
      if (!before) throw new Error(`workspace ${ctx.workspaceId} not found for tenant context`);
      if (
        patch.dailyCapPerAccount !== undefined ||
        patch.notionWebhooks !== undefined ||
        patch.providers !== undefined ||
        patch.notificationEmail !== undefined ||
        patch.alertCopyEmail !== undefined ||
        patch.links !== undefined ||
        patch.evergreen !== undefined ||
        patch.approval !== undefined
      ) {
        // Unknown keys are kept; known keys are replaced or removed explicitly.
        const merged: Record<string, unknown> = { ...(before.settings as Record<string, unknown>) };
        const settings: WorkspaceSettings = { ...readSettings(before) };
        if (patch.dailyCapPerAccount === null) {
          delete settings.dailyCapPerAccount;
          delete merged['dailyCapPerAccount'];
        } else if (patch.dailyCapPerAccount !== undefined) {
          settings.dailyCapPerAccount = patch.dailyCapPerAccount;
        }
        if (patch.notionWebhooks !== undefined) settings.notionWebhooks = patch.notionWebhooks;
        if (patch.providers !== undefined) {
          const providers = { ...(settings.providers ?? {}) };
          for (const [k, v] of Object.entries(patch.providers)) {
            if (typeof v === 'boolean') providers[k as FlaggedProvider] = v;
          }
          settings.providers = providers;
        }
        for (const k of ['notificationEmail', 'alertCopyEmail'] as const) {
          const v = patch[k];
          if (v === null) {
            delete settings[k];
            delete merged[k];
          } else if (v !== undefined) settings[k] = v;
        }
        for (const k of ['links', 'evergreen', 'approval'] as const) {
          const v = patch[k];
          if (v === null) {
            delete settings[k];
            delete merged[k];
          } else if (v !== undefined) {
            // Structured settings replace the previous value; the reader normalises them.
            (settings as unknown as Record<string, unknown>)[k] = v;
          }
        }
        values.settings = { ...merged, ...settings };
      }
      const [after] = await tx
        .update(workspace)
        .set(values)
        .where(and(eq(workspace.id, ctx.workspaceId), isNull(workspace.deletedAt)))
        .returning();
      if (!after) throw new Error(`workspace ${ctx.workspaceId} vanished during update`);
      const changed: Record<string, { from: unknown; to: unknown }> = Object.fromEntries(
        (['name', 'defaultTimezone', 'defaultPublishTime'] as const)
          .filter((k) => before[k] !== after[k])
          .map((k) => [k, { from: before[k], to: after[k] }]),
      );
      const settingsBefore = readSettings(before);
      const settingsAfter = readSettings(after);
      for (const k of [
        'dailyCapPerAccount',
        'notionWebhooks',
        'notificationEmail',
        'alertCopyEmail',
      ] as const) {
        if (settingsBefore[k] !== settingsAfter[k]) {
          changed[k] = { from: settingsBefore[k] ?? null, to: settingsAfter[k] ?? null };
        }
      }
      if (
        JSON.stringify(settingsBefore.providers ?? {}) !==
        JSON.stringify(settingsAfter.providers ?? {})
      ) {
        changed['providers'] = {
          from: settingsBefore.providers ?? {},
          to: settingsAfter.providers ?? {},
        };
      }
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        event: 'workspace.updated',
        correlationId: ctx.correlationId,
        data: { changed },
      });
      return after;
    });
  }
}
