import type { FastifyPluginAsync } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { APIError } from 'better-auth';
import { z } from 'zod';
import {
  ConnectionError,
  type SocialAccountService,
} from '../../modules/connections/social-account.service.js';
import {
  ContentSourceValidationError,
  type ContentSourceService,
} from '../../modules/content-sources/content-source.service.js';
import type { NotionSyncService } from '../../modules/content-sources/notion/notion-sync.service.js';
import type { HeartbeatService } from '../../modules/ops/heartbeat.service.js';
import { providerEnabled } from '../../modules/workspaces/settings.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { loadUser, sameOriginGuard } from '../plugins/auth.js';
import { requireMembership } from '../plugins/tenancy.js';
import { html, layout, type RawHtml } from '../views/html.js';

export interface PagesOptions {
  workspaces: WorkspaceService;
  socialAccounts: SocialAccountService;
  contentSources: ContentSourceService;
  notionSync: NotionSyncService;
  heartbeat: HeartbeatService;
  appBaseUrl: string;
  linkedinConfigured: boolean;
  xConfigured: boolean;
  metaConfigured: boolean;
  providerMode: 'fake' | 'live';
}

const signInForm = z.object({ email: z.email(), next: z.string().optional() });
/** Only same-origin paths may be used as the post-sign-in destination (no open redirects). */
const safeNext = (p: string | undefined) =>
  p && p.startsWith('/') && !p.startsWith('//') && !/[\r\n\\]/.test(p) ? p : '/';
const notionForm = z.object({ token: z.string().min(1), database: z.string().min(1) });

/**
 * Server-rendered admin pages (architecture §2.4): no client-side JavaScript,
 * forms post to our own routes, which call services server-side.
 */
export const pageRoutes: FastifyPluginAsync<PagesOptions> = async (app, opts) => {
  const guard = sameOriginGuard(opts.appBaseUrl);
  const memberPage = requireMembership(opts.workspaces, 'viewer', { mode: 'page' });
  const adminPage = requireMembership(opts.workspaces, 'admin', { mode: 'page' });

  app.get('/sign-in', async (req, reply) => {
    await loadUser(req);
    if (req.user) return reply.redirect('/');
    const { sent, error, next } = req.query as { sent?: string; error?: string; next?: string };
    return reply.type('text/html').send(
      layout(
        'Sign in',
        html`
          <header><h1>Postelyo</h1></header>
          ${
            sent
              ? html`<p class="notice">
                  Check your inbox at <strong>${sent}</strong> for a sign-in link. It is valid for
                  15 minutes.
                </p>`
              : null
          }
          ${error ? html`<p class="notice error">${error}</p>` : null}
          <form method="post" action="/sign-in">
            <label for="email">Email address</label>
            <input id="email" name="email" type="email" required autocomplete="email" />
            <input type="hidden" name="next" value="${safeNext(next)}" />
            <p><button type="submit">Send sign-in link</button></p>
          </form>
        `,
      ),
    );
  });

  app.post('/sign-in', { preHandler: guard }, async (req, reply) => {
    const parsed = signInForm.safeParse(req.body);
    if (!parsed.success) {
      return reply.redirect(
        '/sign-in?error=' + encodeURIComponent('Please enter a valid email address.'),
      );
    }
    const email = parsed.data.email.toLowerCase();
    try {
      await app.auth.api.signInMagicLink({
        body: { email, callbackURL: safeNext(parsed.data.next) },
        headers: fromNodeHeaders(req.headers),
      });
    } catch (err) {
      if (err instanceof APIError && err.status === 'TOO_MANY_REQUESTS') {
        return reply.redirect(
          '/sign-in?error=' + encodeURIComponent('Too many attempts. Try again in a minute.'),
        );
      }
      throw err;
    }
    return reply.redirect('/sign-in?sent=' + encodeURIComponent(email));
  });

  app.post('/sign-out', { preHandler: guard }, async (req, reply) => {
    const res = await app.auth.api.signOut({
      headers: fromNodeHeaders(req.headers),
      asResponse: true,
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length > 0) void reply.header('set-cookie', cookies);
    return reply.redirect('/sign-in');
  });

  app.get('/', async (req, reply) => {
    await loadUser(req);
    if (!req.user) return reply.redirect('/sign-in');
    const { error } = req.query as { error?: string };
    // Provisioning is idempotent; this also repairs a sign-up whose hook failed.
    await opts.workspaces.ensureDefaultWorkspace(req.user, req.id);
    const memberships = await opts.workspaces.listForUser(req.user.id);
    return reply.type('text/html').send(
      layout(
        'Home',
        html`
          ${header(req.user.email)} ${error ? html`<p class="notice error">${error}</p>` : null}
          <h2>Your workspaces</h2>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${memberships.map(
                (m) =>
                  html`<tr>
                    <td>${m.name}</td>
                    <td><code>${m.slug}</code></td>
                    <td>${m.role}</td>
                    <td>
                      <a href="/w/${m.id}/posts">Posts</a> ·
                      <a href="/w/${m.id}/connections">Connections</a>
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>
        `,
      ),
    );
  });

  // --- connections page ----------------------------------------------------

  app.get('/w/:workspaceId/connections', { preHandler: memberPage }, async (req, reply) => {
    const ctx = req.tenant!;
    const { connected, error, notice } = req.query as {
      connected?: string;
      error?: string;
      notice?: string;
    };
    const [ws, accounts, sources, workerAge] = await Promise.all([
      opts.workspaces.get(ctx),
      opts.socialAccounts.list(ctx),
      opts.contentSources.list(ctx),
      opts.heartbeat.latestAgeSeconds(),
    ]);
    const canManage =
      ctx.actor.type === 'user' && (ctx.actor.role === 'owner' || ctx.actor.role === 'admin');
    const activeAccounts = accounts.filter((a) => !a.disconnectedAt);
    const profiles = activeAccounts.filter(
      (a) => a.provider === 'linkedin' && a.accountType === 'member',
    );
    const pages = activeAccounts.filter(
      (a) => a.provider === 'linkedin' && a.accountType === 'organization',
    );
    const xAccounts = activeAccounts.filter((a) => a.provider === 'x');
    const fbAccounts = activeAccounts.filter((a) => a.provider === 'facebook');
    const igAccounts = activeAccounts.filter((a) => a.provider === 'instagram');
    const flags = {
      x: providerEnabled(ws, 'x'),
      facebook: providerEnabled(ws, 'facebook'),
      instagram: providerEnabled(ws, 'instagram'),
    };
    const activeSources = sources.filter((s) => !s.disconnectedAt);
    const base = `/w/${ws.id}/connections`;
    const accountRows = (rows: typeof activeAccounts) =>
      rows.map(
        (a) =>
          html`<tr>
            <td>${a.displayName}</td>
            <td>${a.status}</td>
            <td>${a.tokenExpiresAt ? a.tokenExpiresAt.toISOString().slice(0, 10) : '—'}</td>
            <td>
              ${
                canManage
                  ? html`<form
                      class="inline"
                      method="post"
                      action="${base}/linkedin/${a.id}/disconnect"
                    >
                      <button type="submit">Disconnect</button>
                    </form>`
                  : null
              }
            </td>
          </tr>`,
      );
    const accountTable = (rows: typeof activeAccounts, label: string) =>
      html`<table>
        <thead>
          <tr>
            <th>${label}</th>
            <th>Status</th>
            <th>Token expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${accountRows(rows)}
        </tbody>
      </table>`;

    return reply.type('text/html').send(
      layout(
        `Connections · ${ws.name}`,
        html`
          ${header(req.user!.email)}
          <p><a href="/">← Workspaces</a> · <a href="/w/${ws.id}/posts">Posts</a></p>
          <h2>${ws.name} · Connections</h2>
          ${
            opts.providerMode === 'fake'
              ? html`<p class="notice error">
                  Test mode (PROVIDER_MODE=fake): posts are processed end to end but nothing is sent
                  to LinkedIn.
                </p>`
              : null
          }
          ${
            workerAge === null || workerAge > 120
              ? html`<p class="notice error">
                  The background worker is not
                  running${workerAge === null ? '' : html` (last seen ${workerAge}s ago)`}. Nothing
                  will be synced or published until it is.
                </p>`
              : html`<p><small>Worker healthy · last heartbeat ${workerAge}s ago.</small></p>`
          }
          ${connected === 'linkedin' ? html`<p class="notice">LinkedIn profile connected.</p>` : null}
          ${connected === 'linkedin-pages' ? html`<p class="notice">LinkedIn Pages connected. Disconnect any you do not want Postelyo to post to.</p>` : null}
          ${connected === 'x' ? html`<p class="notice">X profile connected.</p>` : null}
          ${connected === 'meta' ? html`<p class="notice">Facebook Pages and linked Instagram accounts connected. Disconnect any you do not want Postelyo to post to.</p>` : null}
          ${notice ? html`<p class="notice">${notice}</p>` : null}
          ${error ? html`<p class="notice error">${error}</p>` : null}

          <h3>LinkedIn profile</h3>
          ${profiles.length === 0 ? html`<p>No LinkedIn profile connected.</p>` : accountTable(profiles, 'Profile')}
          ${
            canManage
              ? opts.linkedinConfigured
                ? html`<p>
                    <a href="/v1/workspaces/${ws.id}/social-accounts/linkedin/connect"
                      >${profiles.length === 0 ? 'Connect LinkedIn profile' : 'Reconnect (refresh authorization)'}</a
                    >
                  </p>`
                : html`<p class="notice error">
                    LinkedIn is not configured on this server (LINKEDIN_CLIENT_ID).
                  </p>`
              : null
          }

          <h3>LinkedIn Pages</h3>
          ${
            pages.length === 0
              ? html`<p>
                  No LinkedIn Page connected. Select <code>LinkedIn Page</code> in Notion's
                  <code>Platforms</code> to post as a page.
                </p>`
              : accountTable(pages, 'Page')
          }
          ${
            canManage && opts.linkedinConfigured
              ? html`<p>
                  <a
                    href="/v1/workspaces/${ws.id}/social-accounts/linkedin/connect?type=organization"
                    >${pages.length === 0 ? 'Connect LinkedIn Pages you administer' : 'Reconnect Pages (refresh authorization)'}</a
                  >
                  <small>Requires Community Management API access for this app.</small>
                </p>`
              : null
          }

          <h3>X</h3>
          ${
            !flags.x
              ? html`<p><small>Not enabled for this workspace.</small></p>`
              : html`${xAccounts.length === 0 ? html`<p>No X profile connected.</p>` : accountTable(xAccounts, 'Profile')}
                ${
                  canManage
                    ? opts.xConfigured
                      ? html`<p>
                          <a href="/v1/workspaces/${ws.id}/social-accounts/x/connect"
                            >${xAccounts.length === 0 ? 'Connect X profile' : 'Connect another X profile'}</a
                          >
                        </p>`
                      : html`<p class="notice error">
                          X is not configured on this server (X_CLIENT_ID).
                        </p>`
                    : null
                }`
          }

          <h3>Facebook Pages and Instagram</h3>
          ${
            !flags.facebook && !flags.instagram
              ? html`<p><small>Not enabled for this workspace.</small></p>`
              : html`${fbAccounts.length === 0 ? html`<p>No Facebook Page connected.</p>` : accountTable(fbAccounts, 'Page')}
                ${igAccounts.length === 0 ? html`<p>No Instagram account connected (link one to a Page in Meta Business Suite).</p>` : accountTable(igAccounts, 'Instagram')}
                ${
                  canManage
                    ? opts.metaConfigured
                      ? html`<p>
                          <a href="/v1/workspaces/${ws.id}/social-accounts/meta/connect"
                            >${fbAccounts.length === 0 ? 'Connect Facebook Pages you manage' : 'Reconnect Pages (refresh authorization)'}</a
                          >
                          <small>Requires Meta app review for publishing permissions.</small>
                        </p>`
                      : html`<p class="notice error">
                          Facebook is not configured on this server (META_APP_ID).
                        </p>`
                    : null
                }`
          }

          <h3>Notion</h3>
          ${
            activeSources.length === 0
              ? html`<p>No Notion database connected.</p>`
              : html`<table>
                    <thead>
                      <tr>
                        <th>Database</th>
                        <th>Status</th>
                        <th>Last sync</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${activeSources.map(
                        (s) =>
                          html`<tr>
                            <td>${s.databaseTitle ?? s.databaseId}</td>
                            <td>${s.status}${s.lastError ? html` · ${s.lastError}` : null}</td>
                            <td>${s.lastSyncAt ? s.lastSyncAt.toISOString() : 'never'}</td>
                            <td>
                              ${
                                canManage
                                  ? html`<form
                                        class="inline"
                                        method="post"
                                        action="${base}/notion/${s.id}/sync"
                                      >
                                        <button type="submit">Sync now</button>
                                      </form>
                                      <form
                                        class="inline"
                                        method="post"
                                        action="${base}/notion/${s.id}/disconnect"
                                      >
                                        <button type="submit">Disconnect</button>
                                      </form>`
                                  : null
                              }
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                  ${
                    activeSources.flatMap((s) => s.warnings).length > 0
                      ? html`<p class="notice">
                    Template warnings:
                    <ul>
                      ${activeSources.flatMap((s) => s.warnings).map((w) => html`<li>${w.message}</li>`)}
                    </ul>
                  </p>`
                      : null
                  }`
          }
          ${
            canManage
              ? html`<form method="post" action="${base}/notion">
                  <label for="token">Notion internal integration token</label>
                  <input id="token" name="token" type="password" required autocomplete="off" />
                  <label for="database">Content database URL or id</label>
                  <input id="database" name="database" type="text" required style="width:100%" />
                  <p>
                    <button type="submit">
                      ${activeSources.length === 0 ? 'Connect Notion database' : 'Update token / database'}
                    </button>
                  </p>
                </form>`
              : null
          }
        `,
      ),
    );
  });

  app.post(
    '/w/:workspaceId/connections/notion',
    { preHandler: [guard, adminPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const base = `/w/${ctx.workspaceId}/connections`;
      const parsed = notionForm.safeParse(req.body);
      if (!parsed.success) {
        return reply.redirect(
          `${base}?error=${encodeURIComponent('Token and database are required.')}`,
        );
      }
      try {
        const dto = await opts.contentSources.connectNotion(ctx, parsed.data);
        return reply.redirect(
          `${base}?notice=${encodeURIComponent(`Notion database "${dto.databaseTitle ?? dto.databaseId}" connected.`)}`,
        );
      } catch (err) {
        if (err instanceof ContentSourceValidationError) {
          const detail =
            err.issues.length > 0 ? ` ${err.issues.map((i) => i.message).join(' ')}` : '';
          return reply.redirect(`${base}?error=${encodeURIComponent(err.message + detail)}`);
        }
        if (err instanceof ConnectionError) {
          return reply.redirect(`${base}?error=${encodeURIComponent(err.message)}`);
        }
        throw err;
      }
    },
  );

  app.post(
    '/w/:workspaceId/connections/notion/:sourceId/disconnect',
    { preHandler: [guard, adminPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { sourceId } = req.params as { sourceId: string };
      await opts.contentSources.disconnect(ctx, sourceId).catch((err: unknown) => {
        if (!(err instanceof ConnectionError)) throw err;
      });
      return reply.redirect(
        `/w/${ctx.workspaceId}/connections?notice=${encodeURIComponent('Notion disconnected.')}`,
      );
    },
  );

  app.post(
    '/w/:workspaceId/connections/notion/:sourceId/sync',
    { preHandler: [guard, adminPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { sourceId } = req.params as { sourceId: string };
      const summary = await opts.notionSync.syncSource(ctx.workspaceId, sourceId, req.id);
      const msg =
        summary.errors.length > 0
          ? `Sync finished with problems: ${summary.errors.join('; ')}`
          : `Synced ${summary.pagesSeen} page(s): ${summary.actions.scheduled} scheduled, ${summary.actions.validation_error} with validation errors, ${summary.writebacks} Notion update(s).`;
      const key = summary.errors.length > 0 ? 'error' : 'notice';
      return reply.redirect(`/w/${ctx.workspaceId}/connections?${key}=${encodeURIComponent(msg)}`);
    },
  );

  app.post(
    '/w/:workspaceId/connections/linkedin/:accountId/disconnect',
    { preHandler: [guard, adminPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { accountId } = req.params as { accountId: string };
      await opts.socialAccounts.disconnect(ctx, accountId).catch((err: unknown) => {
        if (!(err instanceof ConnectionError)) throw err;
      });
      return reply.redirect(
        `/w/${ctx.workspaceId}/connections?notice=${encodeURIComponent('LinkedIn disconnected.')}`,
      );
    },
  );
};

function header(email: string): RawHtml {
  return html`<header>
    <h1><a href="/" style="text-decoration:none;color:inherit">Postelyo</a></h1>
    <form class="inline" method="post" action="/sign-out">
      <span>${email}</span> <button type="submit">Sign out</button>
    </form>
  </header>`;
}
