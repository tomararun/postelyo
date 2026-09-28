import type { FastifyPluginAsync } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { magicLinkCapture } from '../../modules/auth/auth.js';
import { SsoError, type SsoService } from '../../modules/enterprise/sso.service.js';
import { requireUser } from '../plugins/auth.js';

export interface SsoRoutesOptions {
  sso: SsoService;
  appBaseUrl: string;
}

/**
 * Phase 7 single sign-on (OIDC). The browser goes IdP → callback → magic-link
 * verify → complete, so the resulting session is an ordinary Better Auth
 * session; SSO adds identity, not a second session mechanism.
 */
export const ssoRoutes: FastifyPluginAsync<SsoRoutesOptions> = async (app, opts) => {
  const signInError = (message: string) => `/sign-in?error=${encodeURIComponent(message)}`;

  /** Does this email domain sign in through SSO? Used by the sign-in form. */
  app.get('/api/auth/sso/lookup', async (req) => {
    const { email } = req.query as { email?: string };
    const conn = email ? await opts.sso.connectionForEmail(email) : null;
    return { sso: conn !== null };
  });

  app.get('/api/auth/sso/start', async (req, reply) => {
    const { email, next } = req.query as { email?: string; next?: string };
    if (!email) return reply.redirect(signInError('Enter your email address.'));
    try {
      const { url } = await opts.sso.start(email, next ?? '/');
      return reply.redirect(url);
    } catch (err) {
      if (err instanceof SsoError) return reply.redirect(signInError(err.message));
      throw err;
    }
  });

  app.get('/api/auth/sso/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (q.error) return reply.redirect(signInError(q.error_description ?? q.error));
    if (!q.code || !q.state)
      return reply.redirect(signInError('The identity provider sent no code.'));
    let identity;
    try {
      identity = await opts.sso.callback(q.state, q.code, req.id);
    } catch (err) {
      if (err instanceof SsoError) return reply.redirect(signInError(err.message));
      throw err;
    }
    // Mint a magic link for the verified identity and follow it instead of emailing it.
    const store: { url?: string } = {};
    await magicLinkCapture.run(store, () =>
      app.auth.api.signInMagicLink({
        body: {
          email: identity.email,
          name: identity.name,
          callbackURL: `/api/auth/sso/complete?s=${encodeURIComponent(identity.stateId)}`,
        },
        headers: fromNodeHeaders(req.headers),
      }),
    );
    if (!store.url) return reply.redirect(signInError('Sign-in could not be completed.'));
    const u = new URL(store.url, opts.appBaseUrl);
    return reply.redirect(u.pathname + u.search);
  });

  app.get('/api/auth/sso/complete', { preHandler: requireUser }, async (req, reply) => {
    const { s } = req.query as { s?: string };
    if (!s) return reply.redirect(signInError('Unknown sign-in request.'));
    try {
      const { redirectTo } = await opts.sso.complete(s, req.user!.id, req.id);
      return reply.redirect(redirectTo);
    } catch (err) {
      if (err instanceof SsoError) return reply.redirect(signInError(err.message));
      throw err;
    }
  });
};
