import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, type AccountService } from '../../modules/account/account.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireUser, sameOriginGuard } from '../plugins/auth.js';

export interface MeRoutesOptions {
  workspaces: WorkspaceService;
  account: AccountService;
  appBaseUrl: string;
}

const deleteBody = z.object({ confirmEmail: z.string().min(3) }).strict();

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

const stamp = (d: Date) => d.toISOString().slice(0, 10);

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (app, opts) => {
  const sameOrigin = sameOriginGuard(opts.appBaseUrl);

  app.get('/v1/me', { preHandler: requireUser }, async (req) => {
    const user = req.user!;
    const memberships = await opts.workspaces.listForUser(user.id);
    return { user, workspaces: memberships };
  });

  /** What deleting the account would do (D64). */
  app.get('/v1/me/deletion-preview', { preHandler: requireUser }, async (req) =>
    opts.account.preview(req.user!.id),
  );

  /** Irreversible self-service account deletion; the body repeats the email as confirmation. */
  app.delete('/v1/me', { preHandler: [requireUser, sameOrigin] }, async (req, reply) => {
    const parsed = deleteBody.safeParse(req.body ?? {});
    if (!parsed.success) return problem(reply, req, 400, 'confirmEmail is required');
    try {
      const result = await opts.account.delete(req.user!.id, parsed.data.confirmEmail, req.id);
      return { ...result, accountDeleted: true };
    } catch (err) {
      if (err instanceof AccountError) {
        const status = err.code === 'blocked' ? 409 : err.code === 'not_found' ? 404 : 400;
        return problem(reply, req, status, err.message, {
          code: err.code,
          workspaces: err.workspaces,
        });
      }
      throw err;
    }
  });

  /** Personal data export as a JSON download (D65). */
  app.get('/v1/me/export', { preHandler: requireUser }, async (req, reply) => {
    const body = await opts.account.exportAccount(req.user!.id, req.id);
    void reply.header(
      'content-disposition',
      `attachment; filename="postelyo-account-${stamp(new Date())}.json"`,
    );
    void reply.header('cache-control', 'no-store');
    return reply.type('application/json').send(JSON.stringify(body, null, 2));
  });
};
