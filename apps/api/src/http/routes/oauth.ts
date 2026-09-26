import type { FastifyPluginAsync } from 'fastify';
import type { LinkedInConnectFlow } from '../../modules/connections/linkedin/linkedin-connect.js';
import type { MetaConnectFlow } from '../../modules/connections/meta/meta-connect.js';
import type { NotionConnectFlow } from '../../modules/connections/notion/notion-connect.js';
import type { XConnectFlow } from '../../modules/connections/x/x-connect.js';
import { loadUser } from '../plugins/auth.js';

export interface OAuthRoutesOptions {
  linkedin: LinkedInConnectFlow | null;
  x: XConnectFlow | null;
  meta: MetaConnectFlow | null;
  notion: NotionConnectFlow | null;
}

/**
 * Provider OAuth callbacks (architecture §6.2). The user must already be signed
 * in; the state row binds the callback to their workspace.
 */
export const oauthRoutes: FastifyPluginAsync<OAuthRoutesOptions> = async (app, opts) => {
  const redirect = (to: string, query: Record<string, string>) => {
    const sep = to.includes('?') ? '&' : '?';
    const qs = Object.entries(query)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `${to}${sep}${qs}`;
  };
  const query = (req: { query: unknown }) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      state: q['state'],
      code: q['code'],
      error: q['error'],
      errorDescription: q['error_description'],
    };
  };

  app.get('/oauth/linkedin/callback', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    if (!opts.linkedin)
      return reply.redirect(redirect('/', { error: 'LinkedIn is not configured.' }));
    const outcome = await opts.linkedin.callback({
      userId: req.user.id,
      correlationId: req.id,
      ...query(req),
    });
    return reply.redirect(
      outcome.ok
        ? redirect(outcome.redirectTo, {
            connected: outcome.accountType === 'organization' ? 'linkedin-pages' : 'linkedin',
          })
        : redirect(outcome.redirectTo, { error: outcome.reason }),
    );
  });

  app.get('/oauth/x/callback', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    if (!opts.x) return reply.redirect(redirect('/', { error: 'X is not configured.' }));
    const outcome = await opts.x.callback({
      userId: req.user.id,
      correlationId: req.id,
      ...query(req),
    });
    return reply.redirect(
      outcome.ok
        ? redirect(outcome.redirectTo, { connected: 'x' })
        : redirect(outcome.redirectTo, { error: outcome.reason }),
    );
  });

  app.get('/oauth/notion/callback', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    if (!opts.notion)
      return reply.redirect(redirect('/', { error: 'Notion OAuth is not configured.' }));
    const q = query(req);
    const outcome = await opts.notion.callback({
      userId: req.user.id,
      correlationId: req.id,
      state: q.state,
      code: q.code,
      error: q.error,
    });
    return reply.redirect(
      outcome.ok
        ? redirect(outcome.redirectTo, { connected: 'notion' })
        : redirect(outcome.redirectTo, { error: outcome.reason }),
    );
  });

  app.get('/oauth/meta/callback', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    if (!opts.meta) return reply.redirect(redirect('/', { error: 'Facebook is not configured.' }));
    const outcome = await opts.meta.callback({
      userId: req.user.id,
      correlationId: req.id,
      ...query(req),
    });
    return reply.redirect(
      outcome.ok
        ? redirect(outcome.redirectTo, { connected: 'meta' })
        : redirect(outcome.redirectTo, { error: outcome.reason }),
    );
  });
};
