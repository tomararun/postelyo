import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  contentSource,
  membership,
  post,
  publication,
  socialAccount,
  workspace,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { JobEnqueuer } from '../publishing/jobs.js';
import type { ProviderRegistry } from '../publishing/registry.js';
import type { SocialAccountService } from '../connections/social-account.service.js';
import { accountRef, providerIdOf } from '../publishing/engine.js';
import { systemContext, type TenantContext } from '../tenancy/tenant-context.js';

export interface WorkspaceDeletionDeps {
  db: Db;
  enqueue: JobEnqueuer;
  providers: ProviderRegistry;
  socialAccounts: SocialAccountService;
  clock: Clock;
  logger: Logger;
}

/**
 * Workspace deletion (Phase 3, security.md §11). `request` soft-deletes at once
 * (the workspace disappears from every listing and the scheduler sees no rows
 * because publications are cancelled); the job then revokes tokens where a
 * provider supports it and hard-deletes the tenant's rows. Audit rows survive
 * with `workspace_id = null` (the FK sets null), which is the anonymised stub.
 */
export class WorkspaceDeletionService {
  constructor(private readonly deps: WorkspaceDeletionDeps) {}

  /** Owner action: soft delete, cancel waiting work, enqueue the purge. */
  async request(ctx: TenantContext): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      const [ws] = await tx
        .update(workspace)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(workspace.id, ctx.workspaceId), isNull(workspace.deletedAt)))
        .returning({ id: workspace.id });
      if (!ws) return;
      await tx
        .update(publication)
        .set({ state: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(publication.workspaceId, ctx.workspaceId),
            inArray(publication.state, ['pending', 'scheduled', 'blocked', 'queued', 'retry_wait']),
          ),
        );
      await tx
        .update(contentSource)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(contentSource.workspaceId, ctx.workspaceId));
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'workspace',
        entityId: ctx.workspaceId,
        event: 'workspace.deleted',
        correlationId: ctx.correlationId,
        data: { stage: 'requested' },
      });
    });
    await this.deps.enqueue.deleteWorkspace({ workspaceId: ctx.workspaceId });
  }

  /** Job: revoke tokens best-effort, then delete the row (cascades to every tenant table). */
  async purge(workspaceId: string, correlationId: string): Promise<'purged' | 'skipped'> {
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    if (!ws || !ws.deletedAt) return 'skipped';
    const ctx = systemContext(workspaceId, 'workspace-delete', correlationId);
    const accounts = await this.deps.db
      .select()
      .from(socialAccount)
      .where(and(eq(socialAccount.workspaceId, workspaceId), isNull(socialAccount.disconnectedAt)));
    let revoked = 0;
    for (const acc of accounts) {
      const provider = this.deps.providers.get(providerIdOf(acc.provider));
      if (!provider.revoke || !acc.accessTokenEnc) continue;
      try {
        await this.deps.socialAccounts.withAccessToken(ctx, acc.id, 'revoke', (token) =>
          provider.revoke!(accountRef(acc), {
            credentials: { accessToken: token },
            correlationId,
            timeoutMs: 10_000,
          }),
        );
        revoked += 1;
      } catch (err) {
        this.deps.logger.warn({ err, accountId: acc.id }, 'token revocation failed (ignored)');
      }
    }
    const [members] = await this.deps.db
      .select({ id: membership.id })
      .from(membership)
      .where(eq(membership.workspaceId, workspaceId));
    const posts = await this.deps.db
      .select({ id: post.id })
      .from(post)
      .where(eq(post.workspaceId, workspaceId));
    // Audit before the row goes: the FK sets workspace_id to null afterwards.
    await recordAudit(this.deps.db, {
      workspaceId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: workspaceId,
      event: 'workspace.deleted',
      correlationId,
      data: {
        stage: 'purged',
        name: ws.name,
        accounts: accounts.length,
        tokensRevoked: revoked,
        posts: posts.length,
        hadMembers: Boolean(members),
      },
    });
    await this.deps.db.delete(workspace).where(eq(workspace.id, workspaceId));
    return 'purged';
  }
}
