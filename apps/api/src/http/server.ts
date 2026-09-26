import formbody from '@fastify/formbody';
import { linkedInConfig, metaConfig, notionOAuthConfig, xConfig, type Env } from '../config/env.js';
import type { Db } from '../infra/db/client.js';
import type { KeyProvider } from '../infra/crypto/key-provider.js';
import type { Logger } from '../infra/logger.js';
import type { Mailer } from '../infra/mailer.js';
import { createAuth } from '../modules/auth/auth.js';
import { LinkedInConnectFlow } from '../modules/connections/linkedin/linkedin-connect.js';
import { LinkedInOAuthClient } from '../modules/connections/linkedin/linkedin-oauth.js';
import { MetaConnectFlow } from '../modules/connections/meta/meta-connect.js';
import { MetaOAuthClient } from '../modules/connections/meta/meta-oauth.js';
import { NotionConnectFlow } from '../modules/connections/notion/notion-connect.js';
import { NotionOAuthClient } from '../modules/connections/notion/notion-oauth.js';
import { OAuthStateService } from '../modules/connections/oauth-state.service.js';
import { XConnectFlow } from '../modules/connections/x/x-connect.js';
import { XOAuthClient } from '../modules/connections/x/x-oauth.js';
import type { Services } from '../services.js';
import { buildApp, type App } from './app.js';
import { authPlugin, decorateAuth } from './plugins/auth.js';
import { billingRoutes } from './routes/billing.js';
import { connectionRoutes } from './routes/connections.js';
import { legalRoutes } from './routes/legal.js';
import { linkRoutes } from './routes/links.js';
import { teamRoutes } from './routes/team.js';
import { mediaRoutes } from './routes/media.js';
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

  const states = new OAuthStateService(deps.db);
  const returnPath = (workspaceId: string) => `/w/${workspaceId}/connections`;
  const fetchOpt = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const li = linkedInConfig(deps.env);
  const linkedin = li
    ? new LinkedInConnectFlow({
        db: deps.db,
        logger: deps.logger,
        client: new LinkedInOAuthClient({
          clientId: li.clientId,
          clientSecret: li.clientSecret,
          redirectUri: new URL('/oauth/linkedin/callback', deps.env.APP_BASE_URL).toString(),
          ...fetchOpt,
        }),
        socialAccounts,
        states,
        returnPath,
      })
    : null;
  const xc = xConfig(deps.env);
  const x = xc
    ? new XConnectFlow({
        db: deps.db,
        logger: deps.logger,
        client: new XOAuthClient({
          clientId: xc.clientId,
          clientSecret: xc.clientSecret,
          redirectUri: new URL('/oauth/x/callback', deps.env.APP_BASE_URL).toString(),
          ...fetchOpt,
        }),
        socialAccounts,
        states,
        returnPath,
      })
    : null;
  const nc = notionOAuthConfig(deps.env);
  const notion = nc
    ? new NotionConnectFlow({
        db: deps.db,
        logger: deps.logger,
        client: new NotionOAuthClient({
          clientId: nc.clientId,
          clientSecret: nc.clientSecret,
          redirectUri: new URL('/oauth/notion/callback', deps.env.APP_BASE_URL).toString(),
          ...fetchOpt,
        }),
        contentSources,
        states,
        setupPath: (workspaceId, sourceId) => `/w/${workspaceId}/setup?source=${sourceId}`,
        returnPath,
      })
    : null;
  const mc = metaConfig(deps.env);
  const meta = mc
    ? new MetaConnectFlow({
        db: deps.db,
        logger: deps.logger,
        client: new MetaOAuthClient({
          appId: mc.clientId,
          appSecret: mc.clientSecret,
          redirectUri: new URL('/oauth/meta/callback', deps.env.APP_BASE_URL).toString(),
          ...fetchOpt,
        }),
        socialAccounts,
        states,
        returnPath,
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
  await app.register(webhookRoutes, {
    notion: deps.services.notionWebhooks,
    billing: deps.services.billing,
  });
  await app.register(legalRoutes);
  await app.register(linkRoutes, { links: deps.services.links });
  await app.register(mediaRoutes, { storage: deps.services.storage });
  await app.register(pageRoutes, {
    workspaces,
    socialAccounts,
    contentSources,
    notionSync,
    heartbeat: deps.services.heartbeat,
    appBaseUrl: deps.env.APP_BASE_URL,
    linkedinConfigured: linkedin !== null,
    xConfigured: x !== null,
    metaConfigured: meta !== null,
    providerMode: deps.env.PROVIDER_MODE,
  });
  await app.register(opsPageRoutes, {
    workspaces,
    postQuery,
    publications,
    appBaseUrl: deps.env.APP_BASE_URL,
  });
  await app.register(oauthRoutes, { linkedin, x, meta, notion });
  await app.register(meRoutes, { workspaces });
  await app.register(workspaceRoutes, { workspaces, deletion: deps.services.deletion });
  await app.register(teamRoutes, { workspaces, invitations: deps.services.invitations });
  await app.register(billingRoutes, { workspaces, billing: deps.services.billing });
  await app.register(connectionRoutes, {
    workspaces,
    socialAccounts,
    contentSources,
    notionSync,
    linkedin,
    x,
    meta,
    notion,
  });
  await app.register(postRoutes, {
    postQuery,
    workspaces,
    approvals: deps.services.approvals,
    campaigns: deps.services.campaigns,
  });
  await app.register(publicationRoutes, { workspaces, publications });
  return app;
}
