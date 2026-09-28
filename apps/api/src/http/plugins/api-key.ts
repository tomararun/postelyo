import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_RATE_LIMIT_PER_MINUTE,
  requestHashOf,
  type ApiKeyService,
  type ApiScope,
} from '../../modules/enterprise/api-key.service.js';

/**
 * Phase 7 public API guard: `Authorization: Bearer pk_live_…` resolves the
 * workspace and scopes, sets `req.tenant` with an `api_key` actor, and
 * applies the per-key token bucket (429 with `Retry-After`). Unknown, revoked,
 * expired and unentitled keys all answer 401 without saying which.
 */

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: { id: string; scopes: ApiScope[] } | null;
  }
}

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

export function requireApiKey(apiKeys: ApiKeyService, scope: ApiScope) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = token ? await apiKeys.authenticate(token) : null;
    if (!key) {
      void reply.header('www-authenticate', 'Bearer realm="postelyo"');
      await problem(reply, req, 401, 'Unauthorized');
      return;
    }
    const bucket = apiKeys.limiter.take(key.id);
    void reply.header('x-ratelimit-limit', String(API_RATE_LIMIT_PER_MINUTE));
    void reply.header('x-ratelimit-remaining', String(bucket.remaining));
    void reply.header('x-ratelimit-reset', String(bucket.resetInSeconds));
    if (!bucket.allowed) {
      void reply.header('retry-after', String(bucket.resetInSeconds));
      await problem(reply, req, 429, 'Too Many Requests', { code: 'rate_limited' });
      return;
    }
    if (!key.scopes.includes(scope)) {
      await problem(reply, req, 403, 'Forbidden', { code: 'insufficient_scope', required: scope });
      return;
    }
    req.apiKey = { id: key.id, scopes: key.scopes };
    req.tenant = {
      workspaceId: key.workspaceId,
      actor: { type: 'api_key', id: key.id },
      correlationId: req.id,
    };
  };
}

/**
 * `Idempotency-Key` for mutating public endpoints: the first response for a
 * key is stored for 24 hours and replayed; the same key with a different
 * request answers 422 (`idempotency_mismatch`).
 */
export async function withIdempotency(
  apiKeys: ApiKeyService,
  req: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<unknown> {
  const raw = req.headers['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  const workspaceId = req.tenant!.workspaceId;
  const path = req.url.split('?')[0]!;
  const hash = requestHashOf(req.method, path, req.body);
  if (key) {
    const found = await apiKeys.findIdempotent(workspaceId, key);
    if (found) {
      if (found.requestHash !== hash)
        return problem(
          reply,
          req,
          422,
          'Idempotency-Key was already used for a different request',
          {
            code: 'idempotency_mismatch',
          },
        );
      void reply.header('idempotent-replayed', 'true');
      return reply.status(found.status).send(found.body);
    }
  }
  const result = await handler();
  if (key && result.status < 500) {
    await apiKeys.storeIdempotent({
      workspaceId,
      key,
      requestHash: hash,
      method: req.method,
      path,
      status: result.status,
      body: result.body,
    });
  }
  return reply.status(result.status).send(result.body);
}
