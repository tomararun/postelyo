import type { FastifyPluginAsync } from 'fastify';
import type { LinkedInConnectFlow } from '../../modules/connections/linkedin/linkedin-connect.js';
import { loadUser } from '../plugins/auth.js';

/**
 * Provider OAuth callbacks (architecture §6.2). The user must already be signed
 * in; the state row binds the callback to their workspace.
 */
export const oauthRoutes: FastifyPluginAsync<{ linkedin: LinkedInConnectFlow | null }> = async (
  app,
  opts,
) => {
  app.get('/oauth/linkedin/callback', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    if (!opts.linkedin)
      return reply.redirect('/?error=' + encodeURIComponent('LinkedIn is not configured.'));

    const q = req.query as Record<string, string | undefined>;
    const outcome = await opts.linkedin.callback({
      userId: req.user.id,
      correlationId: req.id,
      state: q['state'],
      code: q['code'],
      error: q['error'],
      errorDescription: q['error_description'],
    });
    const sep = outcome.redirectTo.includes('?') ? '&' : '?';
    return reply.redirect(
      outcome.ok
        ? `${outcome.redirectTo}${sep}connected=${outcome.accountType === 'organization' ? 'linkedin-pages' : 'linkedin'}`
        : `${outcome.redirectTo}${sep}error=${encodeURIComponent(outcome.reason)}`,
    );
  });
};
