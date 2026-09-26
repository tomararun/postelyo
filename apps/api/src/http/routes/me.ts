import type { FastifyPluginAsync } from 'fastify';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireUser } from '../plugins/auth.js';

export const meRoutes: FastifyPluginAsync<{ workspaces: WorkspaceService }> = async (app, opts) => {
  app.get('/v1/me', { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    const memberships = await opts.workspaces.listForUser(user.id);
    return { user, workspaces: memberships };
  });
};
