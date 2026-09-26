import type { FastifyPluginAsync } from 'fastify';
import type { PostQueryService } from '../../modules/posts/post-query.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireMembership } from '../plugins/tenancy.js';

export interface PostRoutesOptions {
  postQuery: PostQueryService;
  workspaces: WorkspaceService;
}

/** Read-only listing for operators and the admin UI (architecture §14.2). */
export const postRoutes: FastifyPluginAsync<PostRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');

  app.get('/v1/workspaces/:workspaceId/posts', { preHandler: viewer }, async (req) => {
    const { state } = req.query as { state?: string };
    return { posts: await opts.postQuery.list(req.tenant!, { state }) };
  });
};
