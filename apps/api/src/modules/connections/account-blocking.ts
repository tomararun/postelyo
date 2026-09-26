import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { publication, socialAccount } from '../../infra/db/schema.js';
import { recordAudit } from '../audit/audit.js';
import { recomputePostState } from '../posts/post-state.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

type Tx = Pick<Db, 'update' | 'insert' | 'select'>;

/**
 * Shared by the publish engine (auth error) and the token-expiry job
 * (architecture §6.3): mark the account and park its waiting publications so
 * the scheduler never dispatches work that cannot succeed.
 */
export async function markAccountNeedsReauth(
  tx: Tx,
  ctx: TenantContext,
  accountId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const [acc] = await tx
    .update(socialAccount)
    .set({ status: 'needs_reauth', updatedAt: now })
    .where(and(eq(socialAccount.id, accountId), eq(socialAccount.status, 'active')))
    .returning({ id: socialAccount.id });
  if (!acc) return false;
  await recordAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    entityType: 'social_account',
    entityId: acc.id,
    event: 'social_account.status_changed',
    fromState: 'active',
    toState: 'needs_reauth',
    correlationId: ctx.correlationId,
    data: { reason },
  });
  return true;
}

export async function blockAccountPublications(
  tx: Tx,
  ctx: TenantContext,
  accountId: string,
  reason: string,
  now: Date,
): Promise<{ id: string; postId: string }[]> {
  const blocked = await tx
    .update(publication)
    .set({ state: 'blocked', updatedAt: now })
    .where(
      and(eq(publication.socialAccountId, accountId), inArray(publication.state, ['scheduled'])),
    )
    .returning({ id: publication.id, postId: publication.postId });
  for (const b of blocked) {
    await recordAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'publication',
      entityId: b.id,
      event: 'publication.state_changed',
      fromState: 'scheduled',
      toState: 'blocked',
      correlationId: ctx.correlationId,
      data: { reason },
    });
    await recomputePostState(tx, ctx, b.postId);
  }
  return blocked;
}
