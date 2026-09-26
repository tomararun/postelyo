import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  invitation,
  membership,
  user,
  workspace,
  type Invitation,
  type Membership,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { BillingService } from '../billing/billing.service.js';
import { roleAtLeast, type Role, type TenantContext } from '../tenancy/tenant-context.js';

export class TeamError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'expired'
      | 'already_member'
      | 'last_owner'
      | 'forbidden'
      | 'invalid_role'
      | 'self',
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: Date;
}

export interface InvitationDeps {
  db: Db;
  mailer: Mailer;
  billing: BillingService;
  clock: Clock;
  appBaseUrl: string;
}

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
/** Roles an inviter may grant: owners may grant anything, admins up to admin. */
const GRANTABLE: Record<Role, Role[]> = {
  owner: ['owner', 'admin', 'editor', 'viewer'],
  admin: ['admin', 'editor', 'viewer'],
  editor: [],
  viewer: [],
};

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Team invitations and membership management (Phase 3). Tokens are random,
 * hashed at rest, single use and expire after 7 days. Accepting requires a
 * signed-in user; the email in the invite is informational (the link is the
 * credential), which matches how magic links already work.
 */
export class InvitationService {
  constructor(private readonly deps: InvitationDeps) {}

  async list(ctx: TenantContext): Promise<InvitationDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(invitation)
        .where(eq(invitation.workspaceId, ctx.workspaceId))
        .orderBy(invitation.createdAt),
    );
    return rows.map(toDto);
  }

  async members(ctx: TenantContext): Promise<MemberDto[]> {
    return withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select({
          userId: membership.userId,
          email: user.email,
          name: user.name,
          role: membership.role,
          joinedAt: membership.createdAt,
        })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(eq(membership.workspaceId, ctx.workspaceId))
        .orderBy(membership.createdAt),
    );
  }

  /** Creates the invitation and emails the link. Returns the DTO (never the token). */
  async invite(ctx: TenantContext, email: string, role: Role): Promise<InvitationDto> {
    const inviterRole = ctx.actor.type === 'user' ? ctx.actor.role : 'owner';
    if (!GRANTABLE[inviterRole].includes(role)) {
      throw new TeamError('invalid_role', `A ${inviterRole} cannot grant the ${role} role.`);
    }
    await this.deps.billing.assertMemberCapacity(ctx.workspaceId);
    const normalised = email.trim().toLowerCase();
    const token = randomBytes(32).toString('base64url');
    const now = this.deps.clock.now();
    const row = await withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [existingMember] = await tx
        .select({ id: membership.id })
        .from(membership)
        .innerJoin(user, eq(user.id, membership.userId))
        .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(user.email, normalised)))
        .limit(1);
      if (existingMember)
        throw new TeamError('already_member', `${normalised} is already a member.`);
      // One open invitation per email: revoke earlier ones.
      await tx
        .update(invitation)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invitation.workspaceId, ctx.workspaceId),
            eq(invitation.email, normalised),
            isNull(invitation.acceptedAt),
            isNull(invitation.revokedAt),
          ),
        );
      const [inserted] = await tx
        .insert(invitation)
        .values({
          id: uuidv7(),
          workspaceId: ctx.workspaceId,
          email: normalised,
          role,
          tokenHash: hashInviteToken(token),
          invitedByUserId: ctx.actor.type === 'user' ? ctx.actor.id : null,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        })
        .returning();
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'membership',
        entityId: inserted!.id,
        event: 'invitation.created',
        correlationId: ctx.correlationId,
        data: { email: normalised, role },
      });
      return inserted!;
    });
    const [ws] = await this.deps.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    await this.deps.mailer.send({
      to: normalised,
      subject: `You are invited to ${ws?.name ?? 'a workspace'} on Postelyo`,
      text: [
        `You have been invited to join the workspace "${ws?.name ?? ''}" on Postelyo as ${role}.`,
        '',
        'Open this link to accept (valid for 7 days):',
        `${this.deps.appBaseUrl}/invitations/${token}`,
        '',
        'If you do not expect this invitation, ignore this email.',
      ].join('\n'),
    });
    return toDto(row);
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    await withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .update(invitation)
        .set({ revokedAt: this.deps.clock.now() })
        .where(
          and(
            eq(invitation.id, id),
            eq(invitation.workspaceId, ctx.workspaceId),
            isNull(invitation.acceptedAt),
            isNull(invitation.revokedAt),
          ),
        )
        .returning({ id: invitation.id });
      if (!row) throw new TeamError('not_found', 'invitation not found');
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'membership',
        entityId: id,
        event: 'invitation.revoked',
        correlationId: ctx.correlationId,
      });
    });
  }

  /** Looks up an open invitation by its link token (for the accept page); null when invalid. */
  async peek(token: string): Promise<{ workspaceName: string; role: Role; email: string } | null> {
    const row = await this.openByToken(token);
    if (!row) return null;
    const [ws] = await this.deps.db
      .select({ name: workspace.name })
      .from(workspace)
      .where(eq(workspace.id, row.workspaceId))
      .limit(1);
    return { workspaceName: ws?.name ?? '', role: row.role, email: row.email };
  }

  /** The signed-in user accepts: membership is created with the invited role. */
  async accept(
    token: string,
    acceptingUser: { id: string; email: string },
    correlationId: string,
  ): Promise<{ workspaceId: string; role: Role }> {
    const row = await this.openByToken(token);
    if (!row)
      throw new TeamError('expired', 'This invitation is invalid, expired or already used.');
    const now = this.deps.clock.now();
    return this.deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(membership)
        .where(
          and(eq(membership.workspaceId, row.workspaceId), eq(membership.userId, acceptingUser.id)),
        )
        .limit(1);
      if (!existing) {
        await tx.insert(membership).values({
          id: uuidv7(),
          workspaceId: row.workspaceId,
          userId: acceptingUser.id,
          role: row.role,
        });
      }
      await tx
        .update(invitation)
        .set({ acceptedAt: now, acceptedByUserId: acceptingUser.id })
        .where(eq(invitation.id, row.id));
      await recordAudit(tx, {
        workspaceId: row.workspaceId,
        actor: { type: 'user', id: acceptingUser.id, role: row.role },
        entityType: 'membership',
        entityId: row.id,
        event: 'invitation.accepted',
        toState: row.role,
        correlationId,
        data: {
          invitedEmail: row.email,
          acceptedBy: acceptingUser.email,
          alreadyMember: Boolean(existing),
        },
      });
      return { workspaceId: row.workspaceId, role: existing?.role ?? row.role };
    });
  }

  /** Changes a member's role. Owners may set any role; admins may set admin/editor/viewer on non-owners. */
  async setRole(ctx: TenantContext, userId: string, role: Role): Promise<Membership> {
    const actorRole = ctx.actor.type === 'user' ? ctx.actor.role : 'owner';
    if (!GRANTABLE[actorRole].includes(role)) {
      throw new TeamError('invalid_role', `A ${actorRole} cannot grant the ${role} role.`);
    }
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [target] = await tx
        .select()
        .from(membership)
        .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.userId, userId)))
        .limit(1);
      if (!target) throw new TeamError('not_found', 'member not found');
      if (target.role === 'owner' && actorRole !== 'owner') {
        throw new TeamError('forbidden', 'Only an owner can change another owner.');
      }
      if (target.role === 'owner' && role !== 'owner')
        await this.assertNotLastOwner(tx, ctx.workspaceId);
      const [updated] = await tx
        .update(membership)
        .set({ role, updatedAt: this.deps.clock.now() })
        .where(eq(membership.id, target.id))
        .returning();
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'membership',
        entityId: target.id,
        event: 'membership.role_changed',
        fromState: target.role,
        toState: role,
        correlationId: ctx.correlationId,
        data: { userId },
      });
      return updated!;
    });
  }

  /** Removes a member (or the actor leaves). The last owner can never be removed. */
  async remove(ctx: TenantContext, userId: string): Promise<void> {
    const actorRole = ctx.actor.type === 'user' ? ctx.actor.role : 'owner';
    const self = ctx.actor.type === 'user' && ctx.actor.id === userId;
    await withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [target] = await tx
        .select()
        .from(membership)
        .where(and(eq(membership.workspaceId, ctx.workspaceId), eq(membership.userId, userId)))
        .limit(1);
      if (!target) throw new TeamError('not_found', 'member not found');
      if (!self && !roleAtLeast(actorRole, 'admin'))
        throw new TeamError('forbidden', 'Not allowed.');
      if (!self && target.role === 'owner' && actorRole !== 'owner') {
        throw new TeamError('forbidden', 'Only an owner can remove another owner.');
      }
      if (target.role === 'owner') await this.assertNotLastOwner(tx, ctx.workspaceId);
      await tx.delete(membership).where(eq(membership.id, target.id));
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'membership',
        entityId: target.id,
        event: 'membership.removed',
        fromState: target.role,
        correlationId: ctx.correlationId,
        data: { userId, self },
      });
    });
  }

  private async assertNotLastOwner(tx: Pick<Db, 'select'>, workspaceId: string): Promise<void> {
    const owners = await tx
      .select({ id: membership.id })
      .from(membership)
      .where(and(eq(membership.workspaceId, workspaceId), eq(membership.role, 'owner')));
    if (owners.length <= 1) {
      throw new TeamError(
        'last_owner',
        'A workspace needs at least one owner. Make someone else an owner first.',
      );
    }
  }

  private async openByToken(token: string): Promise<Invitation | null> {
    const [row] = await this.deps.db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.tokenHash, hashInviteToken(token)),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          gt(invitation.expiresAt, this.deps.clock.now()),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

function toDto(i: Invitation): InvitationDto {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    revokedAt: i.revokedAt,
    createdAt: i.createdAt,
  };
}
