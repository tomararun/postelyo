import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiKeyError,
  API_SCOPES,
  type ApiKeyService,
} from '../../modules/enterprise/api-key.service.js';
import type { AuditArchiveService } from '../../modules/enterprise/audit-archive.service.js';
import { SsoError, type SsoService } from '../../modules/enterprise/sso.service.js';
import {
  TenantKeyError,
  type TenantKeyService,
} from '../../modules/enterprise/tenant-key.service.js';
import {
  DELIVERABLE_EVENTS,
  WebhookError,
  type WebhookService,
} from '../../modules/enterprise/webhook.service.js';
import type { BillingService } from '../../modules/billing/billing.service.js';
import { PLANS, planHas } from '../../modules/billing/plans.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { requireMembership } from '../plugins/tenancy.js';

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

function mapError(reply: FastifyReply, req: FastifyRequest, err: unknown) {
  if (
    err instanceof ApiKeyError ||
    err instanceof WebhookError ||
    err instanceof SsoError ||
    err instanceof TenantKeyError
  ) {
    const status =
      err.code === 'not_found'
        ? 404
        : err.code === 'not_entitled'
          ? 402
          : err.code === 'invalid' || err.code === 'discovery'
            ? 400
            : err.code === 'denied'
              ? 403
              : 409;
    return problem(reply, req, status, err.message, { code: err.code });
  }
  throw err;
}

const apiKeyBody = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(API_SCOPES)).min(1),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
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

const ssoBody = z
  .object({
    issuer: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1).optional(),
    emailDomain: z.string().min(3),
    defaultRole: z.enum(['admin', 'editor', 'viewer']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export interface EnterpriseRoutesOptions {
  workspaces: WorkspaceService;
  billing: BillingService;
  apiKeys: ApiKeyService;
  webhooks: WebhookService;
  sso: SsoService;
  tenantKeys: TenantKeyService;
  auditArchive: AuditArchiveService;
  region: string;
  appBaseUrl: string;
}

/** Phase 7 dashboard endpoints: Developers (API keys, webhooks) and Security (SSO, tenant keys, audit export). */
export const enterpriseRoutes: FastifyPluginAsync<EnterpriseRoutesOptions> = async (app, opts) => {
  const viewer = requireMembership(opts.workspaces, 'viewer');
  const admin = requireMembership(opts.workspaces, 'admin');
  const owner = requireMembership(opts.workspaces, 'owner');

  const entitlements = async (workspaceId: string) => {
    const plan = await opts.billing.planFor(workspaceId);
    return {
      plan,
      planName: PLANS[plan].name,
      publicApi: planHas(plan, 'publicApi'),
      webhooks: planHas(plan, 'webhooks'),
      auditExport: planHas(plan, 'auditExport'),
      sso: planHas(plan, 'sso'),
      tenantKeys: planHas(plan, 'tenantKeys'),
    };
  };

  // --- Developers ------------------------------------------------------------

  app.get('/v1/workspaces/:workspaceId/developers', { preHandler: viewer }, async (req) => {
    const ctx = req.tenant!;
    const [entitled, apiKeys, webhooks, deliveries] = await Promise.all([
      entitlements(ctx.workspaceId),
      opts.apiKeys.list(ctx),
      opts.webhooks.list(ctx),
      opts.webhooks.deliveries(ctx, undefined, 50),
    ]);
    return {
      entitled,
      apiKeys,
      webhooks,
      deliveries,
      events: DELIVERABLE_EVENTS,
      openapiUrl: `${opts.appBaseUrl}/api/v1/openapi.json`,
      apiBaseUrl: `${opts.appBaseUrl}/api/v1`,
    };
  });

  app.post('/v1/workspaces/:workspaceId/api-keys', { preHandler: admin }, async (req, reply) => {
    const parsed = apiKeyBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'name and scopes are required', {
        issues: parsed.error.issues,
      });
    try {
      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 3600_000)
        : null;
      const created = await opts.apiKeys.create(req.tenant!, {
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        expiresAt,
      });
      return reply.status(201).send(created);
    } catch (err) {
      return mapError(reply, req, err);
    }
  });

  app.delete(
    '/v1/workspaces/:workspaceId/api-keys/:keyId',
    { preHandler: admin },
    async (req, reply) => {
      const { keyId } = req.params as { keyId: string };
      try {
        await opts.apiKeys.revoke(req.tenant!, keyId);
        return { ok: true };
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  app.post('/v1/workspaces/:workspaceId/webhooks', { preHandler: admin }, async (req, reply) => {
    const parsed = webhookBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'url is required', { issues: parsed.error.issues });
    try {
      return reply.status(201).send(await opts.webhooks.create(req.tenant!, parsed.data));
    } catch (err) {
      return mapError(reply, req, err);
    }
  });

  app.patch(
    '/v1/workspaces/:workspaceId/webhooks/:endpointId',
    { preHandler: admin },
    async (req, reply) => {
      const { endpointId } = req.params as { endpointId: string };
      const parsed = webhookPatch.safeParse(req.body ?? {});
      if (!parsed.success)
        return problem(reply, req, 400, 'invalid webhook update', { issues: parsed.error.issues });
      try {
        return await opts.webhooks.update(req.tenant!, endpointId, parsed.data);
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  app.delete(
    '/v1/workspaces/:workspaceId/webhooks/:endpointId',
    { preHandler: admin },
    async (req, reply) => {
      const { endpointId } = req.params as { endpointId: string };
      try {
        await opts.webhooks.remove(req.tenant!, endpointId);
        return { ok: true };
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/webhooks/:endpointId/test',
    { preHandler: admin },
    async (req, reply) => {
      const { endpointId } = req.params as { endpointId: string };
      try {
        return await opts.webhooks.sendTest(req.tenant!, endpointId);
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  app.get(
    '/v1/workspaces/:workspaceId/webhooks/:endpointId/deliveries',
    { preHandler: viewer },
    async (req) => {
      const { endpointId } = req.params as { endpointId: string };
      return { deliveries: await opts.webhooks.deliveries(req.tenant!, endpointId, 100) };
    },
  );

  // --- Security --------------------------------------------------------------

  app.get('/v1/workspaces/:workspaceId/security', { preHandler: admin }, async (req) => {
    const ctx = req.tenant!;
    const [entitled, sso, tenantKeys] = await Promise.all([
      entitlements(ctx.workspaceId),
      opts.sso.get(ctx),
      opts.tenantKeys.status(ctx),
    ]);
    return {
      entitled,
      region: opts.region,
      sso,
      ssoRedirectUri: opts.sso.redirectUri(),
      tenantKeys,
    };
  });

  app.put('/v1/workspaces/:workspaceId/sso', { preHandler: owner }, async (req, reply) => {
    const parsed = ssoBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return problem(reply, req, 400, 'issuer, clientId and emailDomain are required', {
        issues: parsed.error.issues,
      });
    try {
      return await opts.sso.upsert(req.tenant!, parsed.data);
    } catch (err) {
      return mapError(reply, req, err);
    }
  });

  app.delete('/v1/workspaces/:workspaceId/sso', { preHandler: owner }, async (req) => {
    await opts.sso.remove(req.tenant!);
    return { ok: true };
  });

  app.post(
    '/v1/workspaces/:workspaceId/tenant-keys/enable',
    { preHandler: owner },
    async (req, reply) => {
      try {
        return await opts.tenantKeys.enable(req.tenant!);
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  app.post(
    '/v1/workspaces/:workspaceId/tenant-keys/rotate',
    { preHandler: owner },
    async (req, reply) => {
      try {
        return await opts.tenantKeys.rotate(req.tenant!);
      } catch (err) {
        return mapError(reply, req, err);
      }
    },
  );

  /** NDJSON export of the audit trail for a range (admins; plan-gated). */
  app.get('/v1/workspaces/:workspaceId/audit/export', { preHandler: admin }, async (req, reply) => {
    const ctx = req.tenant!;
    const entitled = await entitlements(ctx.workspaceId);
    if (!entitled.auditExport)
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
    void reply.header(
      'content-disposition',
      `attachment; filename="audit-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.ndjson"`,
    );
    const chunks: string[] = [];
    for await (const row of opts.auditArchive.export(ctx, range)) chunks.push(JSON.stringify(row));
    return reply.send(chunks.length > 0 ? chunks.join('\n') + '\n' : '');
  });
};

export function parseRange(q: { from?: string; to?: string }): { from: Date; to: Date } | null {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 24 * 3600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (to.getTime() <= from.getTime()) return null;
  if (to.getTime() - from.getTime() > 366 * 24 * 3600_000) return null;
  return { from, to };
}
