import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { approval, post, workspace, type Post } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { CanonicalContent } from './content.js';
import { canApprove, approvalRequired } from '../workspaces/settings.js';
import type { Role, TenantContext } from '../tenancy/tenant-context.js';
import type { JobEnqueuer } from '../publishing/jobs.js';

/**
 * Phase 4 opt-in approval enforcement. Notion cannot enforce who sets `Ready`,
 * so a reviewer approves in the dashboard and the approval is bound to a
 * fingerprint of what they saw (title, platforms, text). Scheduling a page
 * whose fingerprint no longer matches the latest approval fails validation.
 */

export class ApprovalError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'not_ready' | 'not_required',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface PendingApproval {
  postId: string;
  title: string;
  externalUrl: string | null;
  sourceStatus: string | null;
  requestedPlatforms: string[];
  requestedPublishLocal: string | null;
  /** True when an approval exists but the content changed since. */
  changedSinceApproval: boolean;
  lastApprovedAt: Date | null;
}

/** Text-only fingerprint: independent of media asset ids and of Postelyo's own writebacks. */
export function approvalFingerprint(input: {
  title: string;
  platforms: string[];
  content: CanonicalContent;
}): string {
  const text = input.content.blocks
    .map((b) =>
      b.type === 'paragraph'
        ? b.inlines.map((i) => i.text).join('')
        : b.items.map((it) => it.map((i) => i.text).join('')).join('\n'),
    )
    .join('\n\n');
  const overrides = Object.entries(input.content.platformText ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
  const body = [
    input.title.trim(),
    [...input.platforms].sort().join(','),
    text,
    overrides,
    input.content.firstComment ?? '',
  ]
    .join('\u0000')
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ');
  return createHash('sha256').update(body).digest('hex');
}

export interface ApprovalServiceDeps {
  db: Db;
  clock: Clock;
  /** When present, an approval re-syncs the page so the `Approval` column updates without an edit. */
  enqueue?: JobEnqueuer;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  /** Latest non-revoked approval fingerprint for a post, or null. */
  async latestFingerprint(postId: string): Promise<{ fp: string; at: Date } | null> {
    const [row] = await this.deps.db
      .select({ fp: approval.contentFp, at: approval.approvedAt })
      .from(approval)
      .where(and(eq(approval.postId, postId), isNull(approval.revokedAt)))
      .orderBy(desc(approval.approvedAt))
      .limit(1);
    return row ?? null;
  }

  /** Ready posts of the workspace with their approval state (dashboard queue). */
  async pending(ctx: TenantContext): Promise<PendingApproval[]> {
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const rows = await tx
        .select()
        .from(post)
        .where(
          and(
            eq(post.workspaceId, ctx.workspaceId),
            eq(post.state, 'ready'),
            isNull(post.deletedAt),
          ),
        )
        .orderBy(post.updatedAt);
      const out: PendingApproval[] = [];
      for (const p of rows) {
        const latest = await this.latestFingerprint(p.id);
        const fp = fingerprintOf(p);
        out.push({
          postId: p.id,
          title: p.title,
          externalUrl: p.externalUrl,
          sourceStatus: p.sourceStatus,
          requestedPlatforms: p.requestedPlatforms,
          requestedPublishLocal: p.requestedPublishLocal,
          changedSinceApproval: latest !== null && latest.fp !== fp,
          lastApprovedAt: latest?.at ?? null,
        });
      }
      return out.filter((o) => o.lastApprovedAt === null || o.changedSinceApproval);
    });
  }

  /** Records an approval for the post's current content. Reviewer check included. */
  async approve(
    ctx: TenantContext,
    postId: string,
    actor: { userId: string; role: Role },
  ): Promise<{ fp: string }> {
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [ws] = await tx.select().from(workspace).where(eq(workspace.id, ctx.workspaceId));
      if (!ws) throw new ApprovalError('not_found', 'workspace not found');
      if (!approvalRequired(ws))
        throw new ApprovalError('not_required', 'Approval enforcement is off for this workspace.');
      if (!canApprove(ws, actor.userId, actor.role))
        throw new ApprovalError('forbidden', 'You are not a reviewer for this workspace.');
      const [p] = await tx
        .select()
        .from(post)
        .where(
          and(eq(post.id, postId), eq(post.workspaceId, ctx.workspaceId), isNull(post.deletedAt)),
        )
        .limit(1);
      if (!p) throw new ApprovalError('not_found', 'post not found');
      if (p.state !== 'ready' && p.state !== 'scheduled')
        throw new ApprovalError('not_ready', 'Only posts in Ready (or Scheduled) can be approved.');
      const fp = p.approvalFp ?? fingerprintOf(p);
      const id = uuidv7();
      await tx.insert(approval).values({
        id,
        workspaceId: ctx.workspaceId,
        postId,
        contentFp: fp,
        approvedByUserId: actor.userId,
        approvedAt: this.deps.clock.now(),
      });
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'approval',
        entityId: id,
        event: 'approval.granted',
        correlationId: ctx.correlationId,
        data: { postId, contentFp: fp },
      });
      if (this.deps.enqueue && p.contentSourceId && p.externalId) {
        await this.deps.enqueue
          .syncPage({
            workspaceId: ctx.workspaceId,
            sourceId: p.contentSourceId,
            pageId: p.externalId,
          })
          .catch(() => undefined);
      }
      return { fp };
    });
  }

  async revoke(ctx: TenantContext, postId: string): Promise<number> {
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const rows = await tx
        .update(approval)
        .set({ revokedAt: this.deps.clock.now() })
        .where(
          and(
            eq(approval.workspaceId, ctx.workspaceId),
            eq(approval.postId, postId),
            isNull(approval.revokedAt),
          ),
        )
        .returning({ id: approval.id });
      for (const r of rows) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'approval',
          entityId: r.id,
          event: 'approval.revoked',
          correlationId: ctx.correlationId,
          data: { postId },
        });
      }
      return rows.length;
    });
  }
}

/** The fingerprint of a stored post row (its snapshot, title and requested platforms). */
export function fingerprintOf(p: Pick<Post, 'title' | 'requestedPlatforms' | 'content'>): string {
  const content = (p.content ?? {}) as Partial<CanonicalContent>;
  return approvalFingerprint({
    title: p.title,
    platforms: p.requestedPlatforms,
    content: {
      v: 1,
      blocks: content.blocks ?? [],
      media: [],
      ...(content.platformText ? { platformText: content.platformText } : {}),
      ...(content.firstComment ? { firstComment: content.firstComment } : {}),
      meta: { source: 'notion' },
    },
  });
}
