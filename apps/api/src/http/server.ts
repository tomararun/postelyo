import formbody from '@fastify/formbody';
import { linkedInConfig, type Env } from '../config/env.js';
import type { Db } from '../infra/db/client.js';
import type { KeyProvider } from '../infra/crypto/key-provider.js';
import type { Logger } from '../infra/logger.js';
import type { Mailer } from '../infra/mailer.js';
import { createAuth } from '../modules/auth/auth.js';
import { LinkedInConnectFlow } from '../modules/connections/linkedin/linkedin-connect.js';
import { LinkedInOAuthClient } from '../modules/connections/linkedin/linkedin-oauth.js';
import { OAuthStateService } from '../modules/connections/oauth-state.service.js';
import type { Services } from '../services.js';
import { buildApp, type App } from './app.js';
import { authPlugin, decorateAuth } from './plugins/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { meRoutes } from './routes/me.js';
import { metricsRoutes } from './routes/metrics.js';
import { oauthRoutes } from './routes/oauth.js';
import { opsPageRoutes } from './routes/pages-ops.js';
import { pageRoutes } from './routes/pages.js';
import { postRoutes } from './routes/posts.js';
import { publicationRoutes } from './routes/publications.js';
import { webhookRoutes } from './routes/webhooks.js';
import { workspaceRoutes } from './routes/workspaces.js';

export interface ServerDeps {
  env: Env;
  logger: Logger;
  db: Db;
  mailer: Mailer;
  keyProvider: KeyProvider;
  services: Services;
  readiness: () => Promise<{ db: boolean }>;
  /** Outbound HTTP for provider calls; injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Full api-role application: core app + identity, tenancy, connections, content, ops pages, and v1 routes. */
export async function buildServer(deps: ServerDeps): Promise<App> {
  const {
    workspaces,
    socialAccounts,
    contentSources,
    notionSync,
    publications,
    postQuery,
    metrics,
  } = deps.services;

  const li = linkedInConfig(deps.env);
  const linkedin = li
    ? new LinkedInConnectFlow({
        db: deps.db,
        logger: deps.logger,
        client: new LinkedInOAuthClient({
          clientId: li.clientId,
          clientSecret: li.clientSecret,
          redirectUri: new URL('/oauth/linkedin/callback', deps.env.APP_BASE_URL).toString(),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        }),
        socialAccounts,
        states: new OAuthStateService(deps.db),
        returnPath: (workspaceId) => `/w/${workspaceId}/connections`,
      })
    : null;

  const auth = createAuth({
    db: deps.db,
    env: deps.env,
    mailer: deps.mailer,
    logger: deps.logger,
    onUserCreated: async (user) => {
      await workspaces.ensureDefaultWorkspace(user, `signup:${user.id}`);
    },
  });

  const app = await buildApp({ logger: deps.logger, readiness: deps.readiness });
  decorateAuth(app, auth);
  await app.register(formbody);
  await app.register(authPlugin, { auth, appBaseUrl: deps.env.APP_BASE_URL });
  await app.register(metricsRoutes, { metrics, token: deps.env.METRICS_TOKEN ?? null });
  await app.register(webhookRoutes, { notion: deps.services.notionWebhooks });
  await app.register(pageRoutes, {
    workspaces,
    socialAccounts,
    contentSources,
    notionSync,
    heartbeat: deps.services.heartbeat,
    appBaseUrl: deps.env.APP_BASE_URL,
    linkedinConfigured: linkedin !== null,
    providerMode: deps.env.PROVIDER_MODE,
  });
  await app.register(opsPageRoutes, {
    workspaces,
    postQuery,
    publications,
    appBaseUrl: deps.env.APP_BASE_URL,
  });
  await app.register(oauthRoutes, { linkedin });
  await app.register(meRoutes, { workspaces });
  await app.register(workspaceRoutes, { workspaces });
  await app.register(connectionRoutes, {
    workspaces,
    socialAccounts,
    contentSources,
    notionSync,
    linkedin,
  });
  await app.register(postRoutes, { postQuery, workspaces });
  await app.register(publicationRoutes, { workspaces, publications });
  return app;
}
