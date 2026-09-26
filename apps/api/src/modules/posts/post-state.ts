import { eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { post, publication } from '../../infra/db/schema.js';
import { recordAudit } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { derivePostState } from './state-machine.js';

type Tx = Pick<Db, 'select' | 'update' | 'insert'>;

/** Recomputes the derived post state from its publications and audits a change (domain-model §3.1). */
export async function recomputePostState(
  tx: Tx,
  ctx: TenantContext,
  postId: string,
): Promise<void> {
  const pubs = await tx
    .select({ state: publication.state })
    .from(publication)
    .where(eq(publication.postId, postId));
  const derived = derivePostState(pubs.map((p) => p.state));
  if (!derived) return;
  const [current] = await tx.select({ state: post.state }).from(post).where(eq(post.id, postId));
  if (!current || current.state === derived) return;
  await tx.update(post).set({ state: derived, updatedAt: new Date() }).where(eq(post.id, postId));
  await recordAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    entityType: 'post',
    entityId: postId,
    event: 'post.state_changed',
    fromState: current.state,
    toState: derived,
    correlationId: ctx.correlationId,
    data: { reason: 'derived_from_publications' },
  });
}
