import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ValidationError,
  type WorkspaceService,
} from '../../modules/workspaces/workspace.service.js';
import type { Workspace } from '../../infra/db/schema.js';
import { dailyCapFor, readSettings } from '../../modules/workspaces/settings.js';
import { requireMembership } from '../plugins/tenancy.js';

const patchSchema = z
  .object({
    name: z.string().optional(),
    defaultTimezone: z.string().optional(),
    defaultPublishTime: z.string().optional(),
    dailyCapPerAccount: z.number().nullable().optional(),
    notionWebhooks: z.boolean().optional(),
    providers: z
      .object({
        x: z.boolean().optional(),
        facebook: z.boolean().optional(),
        instagram: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Public DTO: never leaks internal columns beyond what the UI needs. */
function toDto(w: Workspace) {
  const settings = readSettings(w);
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    defaultTimezone: w.defaultTimezone,
    defaultPublishTime: w.defaultPublishTime.slice(0, 5),
    plan: w.plan,
    dailyCapPerAccount: dailyCapFor(w),
    dailyCapIsDefault: settings.dailyCapPerAccount === undefined,
    notionWebhooks: settings.notionWebhooks === true,
    providers: {
      linkedin: true,
      x: settings.providers?.x === true,
      facebook: settings.providers?.facebook === true,
      instagram: settings.providers?.instagram === true,
    },
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export const workspaceRoutes: FastifyPluginAsync<{ workspaces: WorkspaceService }> = async (
  app,
  opts,
) => {
  const { workspaces } = opts;

  app.get(
    '/v1/workspaces/:workspaceId',
    { preHandler: requireMembership(workspaces, 'viewer') },
    async (req) => toDto(await workspaces.get(req.tenant!)),
  );

  app.patch(
    '/v1/workspaces/:workspaceId',
    { preHandler: requireMembership(workspaces, 'admin') },
    async (req, reply) => {
      const parsed = patchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.badRequest(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      try {
        return toDto(await workspaces.update(req.tenant!, parsed.data));
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.status(422).type('application/problem+json').send({
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            instance: req.url,
            code: 'validation_error',
            issues: err.issues,
          });
        }
        throw err;
      }
    },
  );
};
