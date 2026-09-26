import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { LinkedInConnectFlow } from '../../modules/connections/linkedin/linkedin-connect.js';
import type { MetaConnectFlow } from '../../modules/connections/meta/meta-connect.js';
import type { NotionConnectFlow } from '../../modules/connections/notion/notion-connect.js';
import type { XConnectFlow } from '../../modules/connections/x/x-connect.js';
import { providerEnabled } from '../../modules/workspaces/settings.js';
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
  x: XConnectFlow | null;
  meta: MetaConnectFlow | null;
  notion: NotionConnectFlow | null;
}

const setupBody = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('create'),
      parentPageId: z.string().min(1),
      title: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ mode: z.literal('existing'), databaseId: z.string().min(1) }).strict(),
]);

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

  app.get('/v1/workspaces/:workspaceId/social-accounts', { preHandler: viewer }, async (req) => {
    const ws = await opts.workspaces.get(req.tenant!);
    return {
      linkedinConfigured: opts.linkedin !== null,
      notionOAuthConfigured: opts.notion !== null,
      /** Providers the server has app credentials for AND the workspace switched on. */
      configured: {
        linkedin: opts.linkedin !== null,
        x: opts.x !== null && providerEnabled(ws, 'x'),
        facebook: opts.meta !== null && providerEnabled(ws, 'facebook'),
        instagram: opts.meta !== null && providerEnabled(ws, 'instagram'),
      },
      accounts: await opts.socialAccounts.list(req.tenant!),
    };
  });

  /** X (Twitter) profile via OAuth 2.0 PKCE (Phase 2); needs the workspace flag. */
  app.get(
    '/v1/workspaces/:workspaceId/social-accounts/x/connect',
    { preHandler: admin },
    async (req, reply) => {
      if (!opts.x) {
        return problem(reply, req, 503, 'X is not configured on this server', {
          code: 'x_not_configured',
        });
      }
      const ws = await opts.workspaces.get(req.tenant!);
      if (!providerEnabled(ws, 'x')) {
        return problem(reply, req, 403, 'X is not enabled for this workspace', {
          code: 'provider_disabled',
        });
      }
      return reply.redirect(await opts.x.start(req.tenant!, req.user!.id));
    },
  );

  /** Facebook Pages and linked Instagram accounts via Facebook Login (Phase 2). */
  app.get(
    '/v1/workspaces/:workspaceId/social-accounts/meta/connect',
    { preHandler: admin },
    async (req, reply) => {
      if (!opts.meta) {
        return problem(reply, req, 503, 'Facebook is not configured on this server', {
          code: 'meta_not_configured',
        });
      }
      const ws = await opts.workspaces.get(req.tenant!);
      if (!providerEnabled(ws, 'facebook') && !providerEnabled(ws, 'instagram')) {
        return problem(
          reply,
          req,
          403,
          'Facebook and Instagram are not enabled for this workspace',
          {
            code: 'provider_disabled',
          },
        );
      }
      return reply.redirect(await opts.meta.start(req.tenant!, req.user!.id));
    },
  );

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

  /** "Connect with Notion" (Phase 3): public integration OAuth; the callback lands on the setup wizard. */
  app.get(
    '/v1/workspaces/:workspaceId/content-sources/notion/connect',
    { preHandler: admin },
    async (req, reply) => {
      if (!opts.notion) {
        return problem(reply, req, 503, 'Notion OAuth is not configured on this server', {
          code: 'notion_oauth_not_configured',
        });
      }
      return reply.redirect(await opts.notion.start(req.tenant!, req.user!.id));
    },
  );

  /** Setup wizard data for a pending OAuth source: pages to create the template in, databases to adopt. */
  app.get(
    '/v1/workspaces/:workspaceId/content-sources/:sourceId/setup',
    { preHandler: admin },
    async (req, reply) => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await opts.contentSources.get(req.tenant!, sourceId);
      if (!source || source.disconnectedAt) return problem(reply, req, 404, 'Not Found');
      try {
        return await opts.contentSources.setupOptions(req.tenant!, sourceId);
      } catch (err) {
        if (err instanceof ConnectionError) {
          return problem(reply, req, 409, err.message, { code: err.code });
        }
        throw err;
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/content-sources/:sourceId/setup',
    { preHandler: admin },
    async (req, reply) => {
      const { sourceId } = req.params as { sourceId: string };
      const parsed = setupBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return problem(reply, req, 400, 'mode with parentPageId or databaseId is required');
      }
      try {
        return await opts.contentSources.completeSetup(req.tenant!, sourceId, parsed.data);
      } catch (err) {
        if (err instanceof ContentSourceValidationError) {
          return problem(reply, req, 422, err.message, { code: err.code, issues: err.issues });
        }
        if (err instanceof ConnectionError) {
          return problem(reply, req, err.code === 'not_found' ? 404 : 409, err.message, {
            code: err.code,
          });
        }
        throw err;
      }
    },
  );

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
