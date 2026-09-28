import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AnalyticsQueryService } from '../../modules/analytics/analytics-query.service.js';
import type { CampaignService } from '../../modules/campaigns/campaign.service.js';
import type { ContentSourceService } from '../../modules/content-sources/content-source.service.js';
import { NotionClient } from '../../modules/content-sources/notion/notion-client.js';
import { propName, type PropertyMap } from '../../modules/content-sources/notion/notion-mapper.js';
import { richText } from '../../modules/content-sources/notion/notion-writeback.js';
import type { ApiKeyService } from '../../modules/enterprise/api-key.service.js';
import type { AuditArchiveService } from '../../modules/enterprise/audit-archive.service.js';
import { WebhookError, type WebhookService } from '../../modules/enterprise/webhook.service.js';
import type { BillingService } from '../../modules/billing/billing.service.js';
import { planHas } from '../../modules/billing/plans.js';
import type { PostQueryService } from '../../modules/posts/post-query.service.js';
import {
  PublicationError,
  type PublicationService,
} from '../../modules/publishing/publication.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireApiKey, withIdempotency } from '../plugins/api-key.js';
import { parseRange } from './enterprise.js';
import { buildOpenApi } from './openapi.js';
import { workspaceDto } from './workspaces.js';

/**
 * Phase 7 public API (`/api/v1`). Everything here is a thin skin over the
 * same services the dashboard uses; the API key guard sets `req.tenant` so
 * tenancy, audit and plan limits behave exactly as for a signed-in member.
 */

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

const newPost = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(20_000).optional(),
    platforms: z.array(z.string().min(1)).max(10).optional(),
    publishAt: z.string().datetime({ offset: true }).optional(),
    status: z.enum(['Draft', 'Scheduled']).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

const webhookBody = z
  .object({
    url: z.string().min(1),
    description: z.string().max(200).optional(),
    events: z.array(z.string()).optional(),
  })
  .strict();

const webhookPatch = z
  .object({
    url: z.string().min(1).optional(),
    description: z.string().max(200).nullable().optional(),
    events: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export interface PublicApiOptions {
  apiKeys: ApiKeyService;
  workspaces: WorkspaceService;
  postQuery: PostQueryService;
  publications: PublicationService;
  campaigns: CampaignService;
  analytics: AnalyticsQueryService;
  auditArchive: AuditArchiveService;
  webhooks: WebhookService;
  contentSources: ContentSourceService;
  billing: BillingService;
  appBaseUrl: string;
  region: string;
  fetchImpl?: typeof fetch;
}

export const publicApiRoutes: FastifyPluginAsync<PublicApiOptions> = async (app, opts) => {
  const read = requireApiKey(opts.apiKeys, 'read');
  const write = requireApiKey(opts.apiKeys, 'write');
  const openapi = buildOpenApi(opts.appBaseUrl);

  app.get('/api/v1/openapi.json', async () => openapi);

  app.get('/api/v1/workspace', { preHandler: read }, async (req) => {
    const ws = await opts.workspaces.get(req.tenant!);
    return workspaceDto(ws, opts.region);
  });

  app.get('/api/v1/posts', { preHandler: read }, async (req) => {
    const q = req.query as { state?: string; since?: string };
    const since = q.since ? new Date(q.since) : null;
    let posts = await opts.postQuery.list(req.tenant!, { state: q.state });
    if (since && !Number.isNaN(since.getTime()))
      posts = posts.filter((p) => p.updatedAt.getTime() >= since.getTime());
    return { posts };
  });

  app.get('/api/v1/posts/:postId', { preHandler: read }, async (req, reply) => {
    const { postId } = req.params as { postId: string };
    const post = (await opts.postQuery.list(req.tenant!)).find((p) => p.id === postId);
    return post ?? problem(reply, req, 404, 'Not Found');
  });

  /** Creates a page in the connected Notion content database; the sync turns it into a post. */
  app.post('/api/v1/posts', { preHandler: write }, async (req, reply) => {
    const parsed = newPost.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'title is required', { issues: parsed.error.issues });
    return withIdempotency(opts.apiKeys, req, reply, async () => {
      const ctx = req.tenant!;
      const source = (await opts.contentSources.list(ctx)).find(
        (s) => s.kind === 'notion' && s.status === 'active' && s.databaseId,
      );
      if (!source)
        return {
          status: 409,
          body: {
            type: 'about:blank',
            title: 'No active Notion content database',
            status: 409,
            code: 'no_content_source',
          },
        };
      const input = parsed.data;
      const created = await opts.contentSources.withToken(
        ctx,
        source.id,
        'sync',
        async (token, row) => {
          const map: PropertyMap = (row.config as { propertyMap?: PropertyMap }).propertyMap ?? {};
          const client = new NotionClient(token, { fetchImpl: opts.fetchImpl ?? fetch });
          const schema = await client.retrieveDatabase(row.externalDatabaseId!);
          const statusName = propName(map, 'Status');
          const statusType = Object.values(schema.properties).find(
            (p) => p.name === statusName,
          )?.type;
          const statusValue = { name: input.status ?? 'Draft' };
          const paragraphs = (input.body ?? '')
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          return client.createPage({
            parent: { database_id: row.externalDatabaseId },
            properties: {
              [propName(map, 'Name')]: { title: richText(input.title) },
              [statusName]:
                statusType === 'status' ? { status: statusValue } : { select: statusValue },
              ...(input.platforms && input.platforms.length > 0
                ? {
                    [propName(map, 'Platforms')]: {
                      multi_select: input.platforms.map((name) => ({ name })),
                    },
                  }
                : {}),
              ...(input.publishAt
                ? { [propName(map, 'Publish Date')]: { date: { start: input.publishAt } } }
                : {}),
              ...(input.note
                ? { [propName(map, 'Postelyo Note')]: { rich_text: richText(input.note) } }
                : {}),
            },
            ...(paragraphs.length > 0
              ? {
                  children: paragraphs.map((p) => ({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: { rich_text: richText(p) },
                  })),
                }
              : {}),
          });
        },
      );
      return {
        status: 201,
        body: {
          notionPageId: created.id,
          notionUrl: created.url,
          sourceId: source.id,
          status: input.status ?? 'Draft',
        },
      };
    });
  });

  app.get('/api/v1/publications/:publicationId', { preHandler: read }, async (req, reply) => {
    const { publicationId } = req.params as { publicationId: string };
    const dto = await opts.publications.get(req.tenant!, publicationId);
    return dto ?? problem(reply, req, 404, 'Not Found');
  });

  app.post(
    '/api/v1/publications/:publicationId/retry',
    { preHandler: write },
    async (req, reply) => {
      const { publicationId } = req.params as { publicationId: string };
      return withIdempotency(opts.apiKeys, req, reply, async () => {
        try {
          return { status: 200, body: await opts.publications.retry(req.tenant!, publicationId) };
        } catch (err) {
          if (err instanceof PublicationError) {
            const status = err.code === 'not_found' ? 404 : 409;
            return {
              status,
              body: { type: 'about:blank', title: err.message, status, code: err.code },
            };
          }
          throw err;
        }
      });
    },
  );

  app.get('/api/v1/campaigns', { preHandler: read }, async (req) => ({
    campaigns: await opts.campaigns.list(req.tenant!),
  }));

  app.get('/api/v1/analytics/summary', { preHandler: read }, async (req) => {
    const q = req.query as { weeks?: string };
    const weeks = Math.min(26, Math.max(1, Number(q.weeks ?? '8') || 8));
    const ws = await opts.workspaces.get(req.tenant!);
    return opts.analytics.summary(req.tenant!.workspaceId, ws.defaultTimezone, weeks);
  });

  app.get('/api/v1/audit', { preHandler: read }, async (req) => {
    const q = req.query as { since?: string; event?: string; limit?: string };
    const since = q.since ? new Date(q.since) : undefined;
    return {
      events: await opts.auditArchive.list(req.tenant!, {
        since: since && !Number.isNaN(since.getTime()) ? since : undefined,
        events: q.event
          ? q.event
              .split(',')
              .map((e) => e.trim())
              .filter(Boolean)
          : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/api/v1/audit/export', { preHandler: read }, async (req, reply) => {
    const ctx = req.tenant!;
    if (!planHas(await opts.billing.planFor(ctx.workspaceId), 'auditExport'))
      return problem(reply, req, 402, 'Audit export needs the Team plan or higher.', {
        code: 'not_entitled',
      });
    const range = parseRange(req.query as { from?: string; to?: string });
    if (!range)
      return problem(
        reply,
        req,
        400,
        'from and to must be ISO dates, to after from, at most 366 days apart',
      );
    void reply.type('application/x-ndjson');
    const chunks: string[] = [];
    for await (const row of opts.auditArchive.export(ctx, range)) chunks.push(JSON.stringify(row));
    return reply.send(chunks.length > 0 ? chunks.join('\n') + '\n' : '');
  });

  // --- Webhooks (REST hooks for Zapier/Make) --------------------------------

  const webhookProblem = (err: unknown) => {
    if (err instanceof WebhookError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_entitled' ? 402 : 400;
      return { status, body: { type: 'about:blank', title: err.message, status, code: err.code } };
    }
    throw err;
  };

  app.get('/api/v1/webhooks', { preHandler: read }, async (req) => ({
    webhooks: await opts.webhooks.list(req.tenant!),
  }));

  app.post('/api/v1/webhooks', { preHandler: write }, async (req, reply) => {
    const parsed = webhookBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'url is required', { issues: parsed.error.issues });
    return withIdempotency(opts.apiKeys, req, reply, async () => {
      try {
        return { status: 201, body: await opts.webhooks.create(req.tenant!, parsed.data) };
      } catch (err) {
        return webhookProblem(err);
      }
    });
  });

  app.patch('/api/v1/webhooks/:endpointId', { preHandler: write }, async (req, reply) => {
    const { endpointId } = req.params as { endpointId: string };
    const parsed = webhookPatch.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'invalid webhook update', { issues: parsed.error.issues });
    return withIdempotency(opts.apiKeys, req, reply, async () => {
      try {
        return {
          status: 200,
          body: await opts.webhooks.update(req.tenant!, endpointId, parsed.data),
        };
      } catch (err) {
        return webhookProblem(err);
      }
    });
  });

  app.delete('/api/v1/webhooks/:endpointId', { preHandler: write }, async (req, reply) => {
    const { endpointId } = req.params as { endpointId: string };
    try {
      await opts.webhooks.remove(req.tenant!, endpointId);
      return { ok: true };
    } catch (err) {
      const p = webhookProblem(err);
      return reply.status(p.status).type('application/problem+json').send(p.body);
    }
  });

  app.get('/api/v1/webhooks/:endpointId/deliveries', { preHandler: read }, async (req) => {
    const { endpointId } = req.params as { endpointId: string };
    return { deliveries: await opts.webhooks.deliveries(req.tenant!, endpointId, 100) };
  });

  app.post('/api/v1/webhooks/:endpointId/test', { preHandler: write }, async (req, reply) => {
    const { endpointId } = req.params as { endpointId: string };
    try {
      return await opts.webhooks.sendTest(req.tenant!, endpointId);
    } catch (err) {
      const p = webhookProblem(err);
      return reply.status(p.status).type('application/problem+json').send(p.body);
    }
  });
};
