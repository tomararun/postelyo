import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ValidationError,
  type WorkspaceService,
} from '../../modules/workspaces/workspace.service.js';
import type { Workspace } from '../../infra/db/schema.js';
import { dailyCapFor, readSettings } from '../../modules/workspaces/settings.js';
import { workspaceDefaultsFromEmail } from '../../modules/workspaces/slug.js';
import type { WorkspaceDeletionService } from '../../modules/workspaces/workspace-deletion.service.js';
import { requireUser } from '../plugins/auth.js';
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
    notificationEmail: z.string().nullable().optional(),
    alertCopyEmail: z.string().nullable().optional(),
    // Phase 4
    links: z
      .object({
        utm: z
          .object({
            source: z.string().max(100).optional(),
            medium: z.string().max(100).optional(),
            campaign: z.string().max(100).optional(),
          })
          .strict()
          .optional(),
        shorten: z.boolean().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    evergreen: z
      .object({
        slots: z.array(z.object({ weekday: z.number().int(), time: z.string() }).strict()).max(50),
        minGapDays: z.number().int().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    approval: z
      .object({ required: z.boolean(), reviewers: z.array(z.string()).max(100) })
      .strict()
      .nullable()
      .optional(),
    ai: z
      .object({
        enabled: z.boolean(),
        model: z.string().max(60).optional(),
        voice: z.string().max(4000).optional(),
        bannedPhrases: z.array(z.string().max(100)).max(100).optional(),
        monthlyTokenBudget: z.number().int().min(0).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const createSchema = z
  .object({ name: z.string().min(1).max(80), defaultTimezone: z.string().min(1).optional() })
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

/** Public DTO: never leaks internal columns beyond what the UI needs. */
export function workspaceDto(w: Workspace, region?: string) {
  const settings = readSettings(w);
  return {
    id: w.id,
    /** Phase 7: deployment region of this installation (data residency). */
    region: region ?? null,
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
    notificationEmail: settings.notificationEmail ?? null,
    alertCopyEmail: settings.alertCopyEmail ?? null,
    links: settings.links ?? null,
    evergreen: settings.evergreen ?? null,
    approval: settings.approval ?? null,
    ai: settings.ai ?? { enabled: false },
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export interface WorkspaceRoutesOptions {
  workspaces: WorkspaceService;
  deletion: WorkspaceDeletionService;
  region?: string;
}

export const workspaceRoutes: FastifyPluginAsync<WorkspaceRoutesOptions> = async (app, opts) => {
  const { workspaces } = opts;

  /** Any signed-in user may create another workspace (Phase 3 workspace switching). */
  app.post('/v1/workspaces', { preHandler: requireUser }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return problem(reply, req, 400, 'name is required (1–80 characters)');
    const { slugBase } = workspaceDefaultsFromEmail(req.user!.email);
    const slug = `${slugBase}-${
      parsed.data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'workspace'
    }`;
    try {
      const ws = await workspaces.create(
        {
          name: parsed.data.name,
          slugBase: slug,
          defaultTimezone: parsed.data.defaultTimezone ?? 'UTC',
        },
        req.user!.id,
        req.id,
      );
      return reply.status(201).send(workspaceDto(ws));
    } catch (err) {
      if (err instanceof ValidationError)
        return problem(reply, req, 422, err.message, { issues: err.issues });
      throw err;
    }
  });

  app.get(
    '/v1/workspaces/:workspaceId',
    { preHandler: requireMembership(workspaces, 'viewer') },
    async (req) => workspaceDto(await workspaces.get(req.tenant!), opts.region),
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
        return workspaceDto(await workspaces.update(req.tenant!, parsed.data), opts.region);
      } catch (err) {
        if (err instanceof ValidationError) {
          return problem(reply, req, 422, 'Validation failed', {
            code: 'validation_error',
            issues: err.issues,
          });
        }
        throw err;
      }
    },
  );

  /** Owner only: soft delete now, purge by job (Phase 3). */
  app.delete(
    '/v1/workspaces/:workspaceId',
    { preHandler: requireMembership(workspaces, 'owner') },
    async (req, reply) => {
      await opts.deletion.request(req.tenant!);
      return reply.status(202).send({ status: 'deleting' });
    },
  );
};
