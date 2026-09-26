import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BillingError, type BillingService } from '../../modules/billing/billing.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireMembership } from '../plugins/tenancy.js';

const checkoutBody = z.object({ plan: z.string().min(1) }).strict();

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

export interface BillingRoutesOptions {
  workspaces: WorkspaceService;
  billing: BillingService;
}

/** Plans, usage, Checkout and Portal links (Phase 3). The webhook lives in webhooks.ts. */
export const billingRoutes: FastifyPluginAsync<BillingRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');
  const owner = requireMembership(opts.workspaces, 'owner');

  app.get('/v1/workspaces/:workspaceId/billing', { preHandler: viewer }, async (req) =>
    opts.billing.usage(req.tenant!),
  );

  app.post(
    '/v1/workspaces/:workspaceId/billing/checkout',
    { preHandler: owner },
    async (req, reply) => {
      const parsed = checkoutBody.safeParse(req.body ?? {});
      if (!parsed.success) return problem(reply, req, 400, 'plan is required');
      try {
        const url = await opts.billing.checkout(req.tenant!, parsed.data.plan, req.user!.email);
        return { url };
      } catch (err) {
        if (err instanceof BillingError) {
          return problem(reply, req, err.code === 'not_configured' ? 503 : 400, err.message, {
            code: err.code,
          });
        }
        throw err;
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/billing/portal',
    { preHandler: owner },
    async (req, reply) => {
      try {
        return { url: await opts.billing.portal(req.tenant!) };
      } catch (err) {
        if (err instanceof BillingError) {
          return problem(reply, req, err.code === 'not_configured' ? 503 : 409, err.message, {
            code: err.code,
          });
        }
        throw err;
      }
    },
  );
};
