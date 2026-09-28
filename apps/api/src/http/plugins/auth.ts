import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { App } from '../app.js';
import type { Auth, SessionUser } from '../../modules/auth/auth.js';
import { getSessionUser } from '../../modules/auth/auth.js';
import type { TenantContext } from '../../modules/tenancy/tenant-context.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: Auth;
  }
  interface FastifyRequest {
    /** Signed-in user, resolved by `requireUser` / `loadUser`. */
    user: SessionUser | null;
    /** Tenant context, resolved by `requireMembership`. */
    tenant: TenantContext | null;
  }
}

export interface AuthPluginOptions {
  auth: Auth;
  appBaseUrl: string;
}

/**
 * Adds the `auth` instance and per-request `user`/`tenant` slots to the root
 * Fastify instance. Must be called on the root app (not inside a plugin) so
 * every route scope can see them.
 */
export function decorateAuth(app: App, auth: Auth): void {
  app.decorate('auth', auth);
  app.decorateRequest('user', null);
  app.decorateRequest('tenant', null);
  app.decorateRequest('apiKey', null);
}

/**
 * Mounts Better Auth under /api/auth/* (architecture §5.1).
 * Provider OAuth (LinkedIn) is a separate module; this is only user sign-in.
 */
export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  // Better Auth needs the raw body; give it its own encapsulated parser scope.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (req, reply) => {
        const url = new URL(req.url, opts.appBaseUrl);
        const init: RequestInit = { method: req.method, headers: fromNodeHeaders(req.headers) };
        if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
          init.body = new Uint8Array(req.body);
        }
        const res = await opts.auth.handler(new Request(url, init));
        void reply.status(res.status);
        res.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') void reply.header(key, value);
        });
        const cookies = res.headers.getSetCookie();
        if (cookies.length > 0) void reply.header('set-cookie', cookies);
        const text = await res.text();
        return reply.send(text.length > 0 ? text : undefined);
      },
    });
  });
};

/** Populate `req.user` if a valid session cookie is present; never rejects. */
export async function loadUser(req: FastifyRequest): Promise<void> {
  if (req.user) return;
  req.user = await getSessionUser(req.server.auth, fromNodeHeaders(req.headers));
}

/** preHandler: 401 (API) when no session. Pages use `loadUser` and redirect instead. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await loadUser(req);
  if (!req.user) {
    await reply.status(401).type('application/problem+json').send({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      instance: req.url,
    });
  }
}

/**
 * preHandler for browser form posts: reject cross-site requests by Origin /
 * Sec-Fetch-Site (security.md §3). Better Auth's own endpoints enforce their own checks.
 */
export function sameOriginGuard(appBaseUrl: string) {
  const expected = new URL(appBaseUrl).origin;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const crossOrigin =
      (typeof origin === 'string' && origin !== expected) ||
      (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none');
    if (crossOrigin) {
      await reply.status(403).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Cross-origin request rejected',
        status: 403,
        instance: req.url,
      });
    }
  };
}
