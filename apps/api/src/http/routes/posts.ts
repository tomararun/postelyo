import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AnalyticsQueryService } from '../../modules/analytics/analytics-query.service.js';
import type { CampaignService } from '../../modules/campaigns/campaign.service.js';
import { ApprovalError, type ApprovalService } from '../../modules/posts/approval.service.js';
import type { PostQueryService } from '../../modules/posts/post-query.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import type { Role } from '../../modules/tenancy/tenant-context.js';
import { requireMembership } from '../plugins/tenancy.js';

export interface PostRoutesOptions {
  postQuery: PostQueryService;
  workspaces: WorkspaceService;
  /** Phase 4 */
  approvals?: ApprovalService;
  campaigns?: CampaignService;
  /** Phase 5 */
  analytics?: AnalyticsQueryService;
}

function problem(
  reply: FastifyReply,
  req: FastifyRequest,
  status: number,
  title: string,
  extra = {},
) {
  return reply
    .status(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, instance: req.url, ...extra });
}

/** Read-only listing for operators and the admin UI (architecture §14.2). */
export const postRoutes: FastifyPluginAsync<PostRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');

  app.get('/v1/workspaces/:workspaceId/posts', { preHandler: viewer }, async (req) => {
    const { state } = req.query as { state?: string };
    return { posts: await opts.postQuery.list(req.tenant!, { state }) };
  });

  // Phase 4: campaigns and approvals.
  app.get('/v1/workspaces/:workspaceId/campaigns', { preHandler: viewer }, async (req) => ({
    campaigns: opts.campaigns ? await opts.campaigns.list(req.tenant!) : [],
  }));

  // Phase 5: analytics summary for the dashboard (weekly rollups, top posts, hashtags, best times).
  app.get('/v1/workspaces/:workspaceId/analytics', { preHandler: viewer }, async (req, reply) => {
    if (!opts.analytics) return problem(reply, req, 404, 'Not Found');
    const q = req.query as { weeks?: string };
    const weeks = Math.min(26, Math.max(1, Number(q.weeks ?? '8') || 8));
    const ws = await opts.workspaces.get(req.tenant!);
    return opts.analytics.summary(req.tenant!.workspaceId, ws.defaultTimezone, weeks);
  });

  app.get('/v1/workspaces/:workspaceId/approvals', { preHandler: viewer }, async (req) => ({
    pending: opts.approvals ? await opts.approvals.pending(req.tenant!) : [],
  }));

  const editor = requireMembership(opts.workspaces, 'editor');
  app.post(
    '/v1/workspaces/:workspaceId/posts/:postId/approve',
    { preHandler: editor },
    async (req, reply) => {
      if (!opts.approvals) return problem(reply, req, 404, 'Not Found');
      const { postId } = req.params as { postId: string };
      try {
        const r = await opts.approvals.approve(req.tenant!, postId, {
          userId: req.user!.id,
          role: (req.tenant!.actor as { role?: Role }).role ?? 'viewer',
        });
        return { postId, contentFp: r.fp };
      } catch (err) {
        if (err instanceof ApprovalError) {
          const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409;
          return problem(reply, req, status, err.message, { code: err.code });
        }
        throw err;
      }
    },
  );

  const admin = requireMembership(opts.workspaces, 'admin');
  app.delete(
    '/v1/workspaces/:workspaceId/posts/:postId/approvals',
    { preHandler: admin },
    async (req, reply) => {
      if (!opts.approvals) return problem(reply, req, 404, 'Not Found');
      const { postId } = req.params as { postId: string };
      const n = await opts.approvals.revoke(req.tenant!, postId);
      return { postId, revoked: n };
    },
  );
};
