import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  approval,
  auditLog,
  campaign,
  contentSource,
  invitation,
  membership,
  post,
  publication,
  publicationMetric,
  session,
  socialAccount,
  user,
  workspace,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { SocialAccountService } from '../connections/social-account.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { WorkspaceDeletionService } from '../workspaces/workspace-deletion.service.js';
import { readSettings } from '../workspaces/settings.js';

/**
 * Self-service account deletion and data export (architecture §7.9, D64, D65).
 *
 * Deletion: workspaces where the user is the only member go through the normal
 * workspace deletion (soft delete now, purge job); in every other workspace the
 * membership ends and social accounts the user connected are disconnected, so a
 * team can never keep posting with a departed person's LinkedIn or X access.
 * Being the sole owner of a workspace that still has other members blocks the
 * deletion until ownership moves. The user row is then deleted (sessions,
 * sign-in records and memberships cascade); audit rows keep the opaque user id
 * only.
 *
 * Export: a personal file (profile, memberships, sessions, invitations sent,
 * own audit trail) and a workspace file for admins (settings, members,
 * connections, campaigns, posts with publications and latest metrics). Neither
 * ever contains tokens, token hashes or secrets.
 */

export class AccountError extends Error {
  constructor(
    public readonly code: 'not_found' | 'confirm_mismatch' | 'blocked',
    message: string,
    public readonly workspaces: { id: string; name: string }[] = [],
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface DeletionPreview {
  /** Deleted with the account: the user is their only member. */
  deleted: { id: string; name: string }[];
  /** The user leaves; their memberships end and accounts they connected are disconnected. */
  left: { id: string; name: string; connectedAccounts: number }[];
  /** Sole owner of a workspace with other members: make someone else owner first. */
  blocking: { id: string; name: string; members: number }[];
}

export interface AccountServiceDeps {
  db: Db;
  deletion: WorkspaceDeletionService;
  socialAccounts: SocialAccountService;
  mailer: Mailer;
  clock: Clock;
  logger: Logger;
}

/** Audit rows included in a personal export (newest first). */
export const EXPORT_AUDIT_LIMIT = 5000;

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  async preview(userId: string): Promise<DeletionPreview> {
    const { db } = this.deps;
    const mine = await db
      .select({ workspaceId: membership.workspaceId, role: membership.role, name: workspace.name })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
      .where(and(eq(membership.userId, userId), isNull(workspace.deletedAt)));
    const out: DeletionPreview = { deleted: [], left: [], blocking: [] };
    if (mine.length === 0) return out;
    const all = await db
      .select({
        workspaceId: membership.workspaceId,
        userId: membership.userId,
        role: membership.role,
      })
      .from(membership)
      .where(
        inArray(
          membership.workspaceId,
          mine.map((m) => m.workspaceId),
        ),
      );
    const connected = await db
      .select({ workspaceId: socialAccount.workspaceId, id: socialAccount.id })
      .from(socialAccount)
      .where(
        and(eq(socialAccount.connectedByUserId, userId), isNull(socialAccount.disconnectedAt)),
      );
    for (const m of mine) {
      const members = all.filter((a) => a.workspaceId === m.workspaceId);
      const others = members.filter((a) => a.userId !== userId);
      if (others.length === 0) {
        out.deleted.push({ id: m.workspaceId, name: m.name });
      } else if (m.role === 'owner' && !others.some((o) => o.role === 'owner')) {
        out.blocking.push({ id: m.workspaceId, name: m.name, members: members.length });
      } else {
        out.left.push({
          id: m.workspaceId,
          name: m.name,
          connectedAccounts: connected.filter((c) => c.workspaceId === m.workspaceId).length,
        });
      }
    }
    return out;
  }

  /** Irreversible. `confirmEmail` must equal the account email (case-insensitive). */
  async delete(
    userId: string,
    confirmEmail: string,
    correlationId: string,
  ): Promise<DeletionPreview> {
    const { db } = this.deps;
    const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!u) throw new AccountError('not_found', 'Account not found.');
    if (confirmEmail.trim().toLowerCase() !== u.email.toLowerCase())
      throw new AccountError('confirm_mismatch', 'Type your account email exactly to confirm.');
    const plan = await this.preview(userId);
    if (plan.blocking.length > 0)
      throw new AccountError(
        'blocked',
        `You are the only owner of ${plan.blocking.map((b) => b.name).join(', ')}. Make another member owner or delete the workspace first.`,
        plan.blocking.map(({ id, name }) => ({ id, name })),
      );

    const actor = { type: 'user' as const, id: userId, role: 'owner' as const };
    for (const ws of plan.deleted) {
      await this.deps.deletion.request({ workspaceId: ws.id, actor, correlationId });
    }
    let disconnected = 0;
    for (const ws of plan.left) {
      const ctx: TenantContext = {
        workspaceId: ws.id,
        actor: { type: 'system', id: 'account-deletion' },
        correlationId,
      };
      const accounts = await db
        .select({ id: socialAccount.id })
        .from(socialAccount)
        .where(
          and(
            eq(socialAccount.workspaceId, ws.id),
            eq(socialAccount.connectedByUserId, userId),
            isNull(socialAccount.disconnectedAt),
            // Child accounts (Instagram under a Page) go with their parent.
            isNull(socialAccount.parentAccountId),
          ),
        );
      for (const a of accounts) {
        try {
          await this.deps.socialAccounts.disconnect(ctx, a.id);
          disconnected += 1;
        } catch (err) {
          this.deps.logger.warn(
            { err, accountId: a.id },
            'disconnect during account deletion failed',
          );
        }
      }
      const [m] = await db
        .select({ id: membership.id, role: membership.role })
        .from(membership)
        .where(and(eq(membership.workspaceId, ws.id), eq(membership.userId, userId)))
        .limit(1);
      await recordAudit(db, {
        workspaceId: ws.id,
        actor: { type: 'system', id: 'account-deletion' },
        entityType: 'membership',
        entityId: m?.id ?? userId,
        event: 'membership.removed',
        correlationId,
        data: {
          reason: 'account_deleted',
          userId,
          role: m?.role ?? null,
          accountsDisconnected: accounts.length,
        },
      });
    }
    // Workspace-free record of the deletion; no email or name is kept.
    await recordAudit(db, {
      workspaceId: null,
      actor: { type: 'user', id: userId, role: 'owner' },
      entityType: 'user',
      entityId: userId,
      event: 'user.deleted',
      correlationId,
      data: {
        workspacesDeleted: plan.deleted.length,
        workspacesLeft: plan.left.length,
        accountsDisconnected: disconnected,
      },
    });
    await db.delete(user).where(eq(user.id, userId));
    try {
      await this.deps.mailer.send({
        to: u.email,
        subject: 'Your Postelyo account has been deleted',
        text: [
          'Your Postelyo account and sign-in have been deleted.',
          plan.deleted.length > 0
            ? `Workspaces deleted with it: ${plan.deleted.map((w) => w.name).join(', ')}. Their content, connections and tokens are purged within minutes.`
            : '',
          plan.left.length > 0
            ? `You were removed from: ${plan.left.map((w) => w.name).join(', ')}. Social accounts you had connected there were disconnected.`
            : '',
          'Content in your Notion workspace is untouched. If you did not ask for this, reply to this email.',
        ]
          .filter((l) => l.length > 0)
          .join('\n\n'),
      });
    } catch (err) {
      this.deps.logger.warn({ err }, 'account deletion email failed (ignored)');
    }
    this.deps.logger.info(
      { correlationId, deleted: plan.deleted.length, left: plan.left.length, disconnected },
      'account deleted',
    );
    return plan;
  }

  /** Personal data export (data portability). */
  async exportAccount(userId: string, correlationId: string): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!u) throw new AccountError('not_found', 'Account not found.');
    await recordAudit(db, {
      workspaceId: null,
      actor: { type: 'user', id: userId, role: 'owner' },
      entityType: 'user',
      entityId: userId,
      event: 'account.exported',
      correlationId,
    });
    const [memberships, sessions, sent, events] = await Promise.all([
      db
        .select({
          workspaceId: membership.workspaceId,
          workspaceName: workspace.name,
          role: membership.role,
          weeklyReport: membership.weeklyReport,
          joinedAt: membership.createdAt,
        })
        .from(membership)
        .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
        .where(eq(membership.userId, userId)),
      db
        .select({
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        })
        .from(session)
        .where(eq(session.userId, userId)),
      db
        .select({
          workspaceId: invitation.workspaceId,
          email: invitation.email,
          role: invitation.role,
          createdAt: invitation.createdAt,
          acceptedAt: invitation.acceptedAt,
          revokedAt: invitation.revokedAt,
        })
        .from(invitation)
        .where(eq(invitation.invitedByUserId, userId)),
      db
        .select({
          occurredAt: auditLog.occurredAt,
          workspaceId: auditLog.workspaceId,
          event: auditLog.event,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          fromState: auditLog.fromState,
          toState: auditLog.toState,
        })
        .from(auditLog)
        .where(and(eq(auditLog.actorType, 'user'), eq(auditLog.actorId, userId)))
        .orderBy(desc(auditLog.occurredAt))
        .limit(EXPORT_AUDIT_LIMIT),
    ]);
    return {
      kind: 'postelyo.account-export',
      version: 1,
      exportedAt: this.deps.clock.now().toISOString(),
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt,
      },
      memberships,
      sessions,
      invitationsSent: sent,
      activity: { events, limitedTo: EXPORT_AUDIT_LIMIT },
      notes:
        'Workspace content (posts, results, connections) is in each workspace export, available to workspace admins. Access tokens are never exported.',
    };
  }

  /** Workspace data export for admins: everything the team created, no secrets. */
  async exportWorkspace(ctx: TenantContext): Promise<Record<string, unknown>> {
    const wsId = ctx.workspaceId;
    await recordAudit(this.deps.db, {
      workspaceId: wsId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: wsId,
      event: 'workspace.exported',
      correlationId: ctx.correlationId,
    });
    return withTenantScope(this.deps.db, wsId, async (tx) => {
      const [ws] = await tx.select().from(workspace).where(eq(workspace.id, wsId)).limit(1);
      if (!ws) throw new AccountError('not_found', 'Workspace not found.');
      const [members, accounts, sources, campaigns, posts, pubs, approvals] = await Promise.all([
        tx
          .select({
            name: user.name,
            email: user.email,
            role: membership.role,
            joinedAt: membership.createdAt,
          })
          .from(membership)
          .innerJoin(user, eq(user.id, membership.userId))
          .where(eq(membership.workspaceId, wsId)),
        tx
          .select({
            id: socialAccount.id,
            provider: socialAccount.provider,
            accountType: socialAccount.accountType,
            displayName: socialAccount.displayName,
            status: socialAccount.status,
            scopes: socialAccount.scopes,
            connectedAt: socialAccount.createdAt,
            disconnectedAt: socialAccount.disconnectedAt,
          })
          .from(socialAccount)
          .where(eq(socialAccount.workspaceId, wsId)),
        tx
          .select({
            id: contentSource.id,
            kind: contentSource.kind,
            status: contentSource.status,
            databaseTitle: contentSource.externalDatabaseTitle,
            lastSyncAt: contentSource.lastSyncAt,
            connectedAt: contentSource.createdAt,
            disconnectedAt: contentSource.disconnectedAt,
          })
          .from(contentSource)
          .where(eq(contentSource.workspaceId, wsId)),
        tx
          .select({
            id: campaign.id,
            name: campaign.name,
            externalUrl: campaign.externalUrl,
            sourceStatus: campaign.sourceStatus,
            startsOn: campaign.startsOn,
            endsOn: campaign.endsOn,
            summary: campaign.summary,
            archivedAt: campaign.archivedAt,
          })
          .from(campaign)
          .where(eq(campaign.workspaceId, wsId)),
        tx.select().from(post).where(eq(post.workspaceId, wsId)).orderBy(desc(post.createdAt)),
        tx.select().from(publication).where(eq(publication.workspaceId, wsId)),
        tx
          .select({
            postId: approval.postId,
            approvedAt: approval.approvedAt,
            revokedAt: approval.revokedAt,
            approvedBy: user.email,
          })
          .from(approval)
          .leftJoin(user, eq(user.id, approval.approvedByUserId))
          .where(eq(approval.workspaceId, wsId)),
      ]);
      const metrics = pubs.length
        ? await tx
            .select()
            .from(publicationMetric)
            .where(eq(publicationMetric.workspaceId, wsId))
            .orderBy(desc(publicationMetric.fetchedAt))
        : [];
      const latest = new Map<string, (typeof metrics)[number]>();
      for (const m of metrics) if (!latest.has(m.publicationId)) latest.set(m.publicationId, m);
      const settings = readSettings(ws);
      return {
        kind: 'postelyo.workspace-export',
        version: 1,
        exportedAt: this.deps.clock.now().toISOString(),
        workspace: {
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          plan: ws.plan,
          defaultTimezone: ws.defaultTimezone,
          defaultPublishTime: ws.defaultPublishTime,
          createdAt: ws.createdAt,
          settings,
        },
        members,
        socialAccounts: accounts,
        contentSources: sources,
        campaigns,
        posts: posts.map((p) => ({
          id: p.id,
          title: p.title,
          state: p.state,
          sourceStatus: p.sourceStatus,
          notionUrl: p.externalUrl,
          campaignId: p.campaignId,
          requestedPlatforms: p.requestedPlatforms,
          requestedPublishLocal: p.requestedPublishLocal,
          requestedTimezone: p.requestedTimezone,
          content: p.content,
          aiAssisted: p.aiAssisted,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          deletedAt: p.deletedAt,
          approvals: approvals.filter((a) => a.postId === p.id),
          publications: pubs
            .filter((x) => x.postId === p.id)
            .map((x) => {
              const m = latest.get(x.id);
              return {
                id: x.id,
                provider: x.provider,
                socialAccountId: x.socialAccountId,
                state: x.state,
                scheduledAt: x.scheduledAt,
                scheduledLocal: x.scheduledLocal,
                scheduledTz: x.scheduledTz,
                publishedAt: x.publishedAt,
                delaySeconds: x.delaySeconds,
                postUrl: x.providerPostUrl,
                lastError: x.lastErrorMessage,
                firstComment: x.firstCommentState,
                latestMetrics: m
                  ? {
                      tier: m.tier,
                      fetchedAt: m.fetchedAt,
                      impressions: m.impressions,
                      reach: m.reach,
                      reactions: m.reactions,
                      comments: m.comments,
                      shares: m.shares,
                      clicks: m.clicks,
                      saves: m.saves,
                    }
                  : null,
              };
            }),
        })),
        notes:
          'Access tokens, refresh tokens, webhook secrets and API keys are never exported. The audit trail has its own export on the Security page.',
      };
    });
  }
}
