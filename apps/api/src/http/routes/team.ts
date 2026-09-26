import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PlanLimitError } from '../../modules/billing/billing.service.js';
import { ROLES } from '../../modules/tenancy/tenant-context.js';
import { TeamError, type InvitationService } from '../../modules/workspaces/invitation.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireUser } from '../plugins/auth.js';
import { requireMembership } from '../plugins/tenancy.js';

const inviteBody = z.object({ email: z.email(), role: z.enum(ROLES) }).strict();
const roleBody = z.object({ role: z.enum(ROLES) }).strict();

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

function mapTeamError(reply: FastifyReply, req: FastifyRequest, err: unknown) {
  if (err instanceof TeamError) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'forbidden' || err.code === 'invalid_role'
          ? 403
          : err.code === 'expired'
            ? 410
            : 409;
    return problem(reply, req, status, err.message, { code: err.code });
  }
  if (err instanceof PlanLimitError) {
    return problem(reply, req, 402, err.message, {
      code: 'plan_limit',
      limit: err.limit,
      plan: err.plan,
    });
  }
  throw err;
}

export interface TeamRoutesOptions {
  workspaces: WorkspaceService;
  invitations: InvitationService;
}

/** Members and invitations (Phase 3). */
export const teamRoutes: FastifyPluginAsync<TeamRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');
  const admin = requireMembership(opts.workspaces, 'admin');

  app.get('/v1/workspaces/:workspaceId/members', { preHandler: viewer }, async (req) => ({
    members: await opts.invitations.members(req.tenant!),
  }));

  app.patch(
    '/v1/workspaces/:workspaceId/members/:userId',
    { preHandler: admin },
    async (req, reply) => {
      const parsed = roleBody.safeParse(req.body ?? {});
      if (!parsed.success) return problem(reply, req, 400, 'role is required');
      const { userId } = req.params as { userId: string };
      try {
        const m = await opts.invitations.setRole(req.tenant!, userId, parsed.data.role);
        return { userId: m.userId, role: m.role };
      } catch (err) {
        return mapTeamError(reply, req, err);
      }
    },
  );

  /** Admins remove others; any member may remove themselves (leave). */
  app.delete(
    '/v1/workspaces/:workspaceId/members/:userId',
    { preHandler: viewer },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      try {
        await opts.invitations.remove(req.tenant!, userId);
        return reply.status(204).send();
      } catch (err) {
        return mapTeamError(reply, req, err);
      }
    },
  );

  app.get('/v1/workspaces/:workspaceId/invitations', { preHandler: admin }, async (req) => ({
    invitations: await opts.invitations.list(req.tenant!),
  }));

  app.post('/v1/workspaces/:workspaceId/invitations', { preHandler: admin }, async (req, reply) => {
    const parsed = inviteBody.safeParse(req.body ?? {});
    if (!parsed.success) return problem(reply, req, 400, 'email and role are required');
    try {
      const dto = await opts.invitations.invite(req.tenant!, parsed.data.email, parsed.data.role);
      return reply.status(201).send(dto);
    } catch (err) {
      return mapTeamError(reply, req, err);
    }
  });

  app.delete(
    '/v1/workspaces/:workspaceId/invitations/:invitationId',
    { preHandler: admin },
    async (req, reply) => {
      const { invitationId } = req.params as { invitationId: string };
      try {
        await opts.invitations.revoke(req.tenant!, invitationId);
        return reply.status(204).send();
      } catch (err) {
        return mapTeamError(reply, req, err);
      }
    },
  );

  /** Invite link handling: peek (any signed-in user) and accept. */
  app.get('/v1/invitations/:token', { preHandler: requireUser }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const info = await opts.invitations.peek(token);
    if (!info)
      return problem(reply, req, 410, 'This invitation is invalid, expired or already used.');
    return info;
  });

  app.post('/v1/invitations/:token/accept', { preHandler: requireUser }, async (req, reply) => {
    const { token } = req.params as { token: string };
    try {
      return await opts.invitations.accept(token, req.user!, req.id);
    } catch (err) {
      return mapTeamError(reply, req, err);
    }
  });
};
