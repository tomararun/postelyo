import type { FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../../shared/ids.js';
import { roleAtLeast, type Role } from '../../modules/tenancy/tenant-context.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { loadUser, requireUser } from './auth.js';

export interface MembershipGuardOptions {
  /** `api` answers 401/404/403 as problem+json; `page` redirects anonymous users to /sign-in. */
  mode?: 'api' | 'page';
}

/**
 * preHandler factory: resolves `req.tenant` from the session user and the
 * `:workspaceId` route param. Non-members and unknown ids get 404, never 403,
 * to avoid tenant enumeration (security.md §4.2). Insufficient role gets 403.
 */
export function requireMembership(
  workspaces: WorkspaceService,
  minRole: Role,
  opts: MembershipGuardOptions = {},
) {
  const mode = opts.mode ?? 'api';
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (mode === 'page') {
      await loadUser(req);
      if (!req.user) {
        await reply.redirect('/sign-in');
        return;
      }
    } else {
      await requireUser(req, reply);
      if (reply.sent || !req.user) return;
    }

    const { workspaceId } = req.params as { workspaceId?: string };
    const member =
      workspaceId && isUuid(workspaceId)
        ? await workspaces.findMembership(req.user.id, workspaceId)
        : null;
    if (!member) {
      await reply.status(404).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        instance: req.url,
      });
      return;
    }
    if (!roleAtLeast(member.role, minRole)) {
      await reply.status(403).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        instance: req.url,
        code: 'insufficient_role',
      });
      return;
    }
    req.tenant = {
      workspaceId: member.workspaceId,
      actor: { type: 'user', id: req.user.id, role: member.role },
      correlationId: req.id,
    };
  };
}
