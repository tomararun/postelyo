import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PublicationError,
  type PublicationService,
} from '../../modules/publishing/publication.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireMembership } from '../plugins/tenancy.js';

export interface PublicationRoutesOptions {
  workspaces: WorkspaceService;
  publications: PublicationService;
}

const resolveBody = z
  .object({
    outcome: z.enum(['published', 'failed']),
    providerPostId: z.string().min(1).optional(),
    providerPostUrl: z.url().optional(),
  })
  .strict();

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

/** Operator endpoints for publications (architecture §14.2). */
export const publicationRoutes: FastifyPluginAsync<PublicationRoutesOptions> = async (
  app,
  opts,
) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');
  const editor = requireMembership(opts.workspaces, 'editor');
  const admin = requireMembership(opts.workspaces, 'admin');

  app.get(
    '/v1/workspaces/:workspaceId/publications/:publicationId',
    { preHandler: viewer },
    async (req, reply) => {
      const { publicationId } = req.params as { publicationId: string };
      const dto = await opts.publications.get(req.tenant!, publicationId);
      return dto ?? problem(reply, req, 404, 'Not Found');
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/publications/:publicationId/retry',
    { preHandler: editor },
    async (req, reply) => {
      const { publicationId } = req.params as { publicationId: string };
      try {
        return await opts.publications.retry(req.tenant!, publicationId);
      } catch (err) {
        if (err instanceof PublicationError) {
          return problem(reply, req, err.code === 'not_found' ? 404 : 409, err.message, {
            code: err.code,
          });
        }
        throw err;
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/publications/:publicationId/resolve',
    { preHandler: admin },
    async (req, reply) => {
      const { publicationId } = req.params as { publicationId: string };
      const parsed = resolveBody.safeParse(req.body ?? {});
      if (!parsed.success) return problem(reply, req, 400, 'outcome must be published or failed');
      try {
        return await opts.publications.resolve(req.tenant!, publicationId, parsed.data);
      } catch (err) {
        if (err instanceof PublicationError) {
          return problem(reply, req, err.code === 'not_found' ? 404 : 409, err.message, {
            code: err.code,
          });
        }
        throw err;
      }
    },
  );
};
