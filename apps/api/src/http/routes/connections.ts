import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LinkedInConnectFlow } from '../../modules/connections/linkedin/linkedin-connect.js';
import {
  ConnectionError,
  type SocialAccountService,
} from '../../modules/connections/social-account.service.js';
import {
  ContentSourceValidationError,
  type ContentSourceService,
} from '../../modules/content-sources/content-source.service.js';
import type { NotionSyncService } from '../../modules/content-sources/notion/notion-sync.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireMembership } from '../plugins/tenancy.js';

export interface ConnectionRoutesOptions {
  workspaces: WorkspaceService;
  socialAccounts: SocialAccountService;
  contentSources: ContentSourceService;
  notionSync: NotionSyncService;
  linkedin: LinkedInConnectFlow | null;
}

const notionBody = z.object({ token: z.string().min(1), database: z.string().min(1) }).strict();
const connectQuery = z.object({ type: z.enum(['member', 'organization']).default('member') });

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

/** Connection management API (architecture §14.2). DTOs never carry tokens. */
export const connectionRoutes: FastifyPluginAsync<ConnectionRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');
  const admin = requireMembership(opts.workspaces, 'admin');

  // --- social accounts -----------------------------------------------------

  app.get('/v1/workspaces/:workspaceId/social-accounts', { preHandler: viewer }, async (req) => ({
    linkedinConfigured: opts.linkedin !== null,
    accounts: await opts.socialAccounts.list(req.tenant!),
  }));

  /** `?type=organization` connects the LinkedIn Pages the member administers (Phase 1). */
  app.get(
    '/v1/workspaces/:workspaceId/social-accounts/linkedin/connect',
    { preHandler: admin },
    async (req, reply) => {
      if (!opts.linkedin) {
        return problem(reply, req, 503, 'LinkedIn is not configured on this server', {
          code: 'linkedin_not_configured',
        });
      }
      const parsed = connectQuery.safeParse(req.query ?? {});
      if (!parsed.success) return problem(reply, req, 400, 'type must be member or organization');
      const url = await opts.linkedin.start(req.tenant!, req.user!.id, parsed.data.type);
      return reply.redirect(url);
    },
  );

  app.delete(
    '/v1/workspaces/:workspaceId/social-accounts/:accountId',
    { preHandler: admin },
    async (req, reply) => {
      const { accountId } = req.params as { accountId: string };
      try {
        await opts.socialAccounts.disconnect(req.tenant!, accountId);
      } catch (err) {
        if (err instanceof ConnectionError && err.code === 'not_found') {
          return problem(reply, req, 404, 'Not Found');
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );

  // --- content sources -----------------------------------------------------

  app.get('/v1/workspaces/:workspaceId/content-sources', { preHandler: viewer }, async (req) => ({
    sources: await opts.contentSources.list(req.tenant!),
  }));

  app.post(
    '/v1/workspaces/:workspaceId/content-sources/notion',
    { preHandler: admin },
    async (req, reply) => {
      const parsed = notionBody.safeParse(req.body ?? {});
      if (!parsed.success) return problem(reply, req, 400, 'token and database are required');
      try {
        const dto = await opts.contentSources.connectNotion(req.tenant!, parsed.data);
        return reply.status(201).send(dto);
      } catch (err) {
        if (err instanceof ContentSourceValidationError) {
          return problem(reply, req, 422, err.message, { code: err.code, issues: err.issues });
        }
        if (err instanceof ConnectionError && err.code === 'already_connected') {
          return problem(reply, req, 409, err.message, { code: err.code });
        }
        throw err;
      }
    },
  );

  /** Manual "Sync now" (PRD §4.2). Runs inline and returns the summary. */
  app.post(
    '/v1/workspaces/:workspaceId/content-sources/:sourceId/sync',
    { preHandler: admin },
    async (req, reply) => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await opts.contentSources.get(req.tenant!, sourceId);
      if (!source || source.disconnectedAt) return problem(reply, req, 404, 'Not Found');
      const summary = await opts.notionSync.syncSource(req.tenant!.workspaceId, sourceId, req.id);
      return reply.status(summary.errors.length > 0 ? 207 : 200).send(summary);
    },
  );

  app.delete(
    '/v1/workspaces/:workspaceId/content-sources/:sourceId',
    { preHandler: admin },
    async (req, reply) => {
      const { sourceId } = req.params as { sourceId: string };
      try {
        await opts.contentSources.disconnect(req.tenant!, sourceId);
      } catch (err) {
        if (err instanceof ConnectionError && err.code === 'not_found') {
          return problem(reply, req, 404, 'Not Found');
        }
        throw err;
      }
      return reply.status(204).send();
    },
  );
};
