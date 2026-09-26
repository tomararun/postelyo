import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PostQueryService } from '../../modules/posts/post-query.service.js';
import {
  PublicationError,
  type PublicationService,
} from '../../modules/publishing/publication.service.js';
import type { WorkspaceService } from '../../modules/workspaces/workspace.service.js';
import { sameOriginGuard } from '../plugins/auth.js';
import { requireMembership } from '../plugins/tenancy.js';
import { fmtDate, pageHeader } from '../views/chrome.js';
import { html, layout } from '../views/html.js';

export interface OpsPagesOptions {
  workspaces: WorkspaceService;
  postQuery: PostQueryService;
  publications: PublicationService;
  appBaseUrl: string;
}

const resolveForm = z.object({
  outcome: z.enum(['published', 'failed']),
  providerPostUrl: z.string().optional(),
});

/** Operator pages: posts list with publication states, retry/resolve, publication detail (PRD §4.8). */
export const opsPageRoutes: FastifyPluginAsync<OpsPagesOptions> = async (app, opts) => {
  const guard = sameOriginGuard(opts.appBaseUrl);
  const memberPage = requireMembership(opts.workspaces, 'viewer', { mode: 'page' });
  const editorPage = requireMembership(opts.workspaces, 'editor', { mode: 'page' });
  const adminPage = requireMembership(opts.workspaces, 'admin', { mode: 'page' });

  app.get('/w/:workspaceId/posts', { preHandler: memberPage }, async (req, reply) => {
    const ctx = req.tenant!;
    const { state, notice, error } = req.query as {
      state?: string;
      notice?: string;
      error?: string;
    };
    const [ws, posts] = await Promise.all([
      opts.workspaces.get(ctx),
      opts.postQuery.list(ctx, { state }),
    ]);
    const canAct = ctx.actor.type === 'user' && ctx.actor.role !== 'viewer';
    return reply.type('text/html').send(
      layout(
        `Posts · ${ws.name}`,
        html`
          ${pageHeader(req.user!.email, ws.id)}
          <h2>${ws.name} · Posts</h2>
          ${notice ? html`<p class="notice">${notice}</p>` : null}
          ${error ? html`<p class="notice error">${error}</p>` : null}
          <p>
            Filter:
            ${['all', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'].map(
              (s) =>
                html`<a href="/w/${ws.id}/posts${s === 'all' ? '' : `?state=${s}`}"
                  >${s === (state ?? 'all') ? html`<strong>${s}</strong>` : s}</a
                > `,
            )}
          </p>
          <table>
            <thead>
              <tr>
                <th>Post</th>
                <th>Notion status</th>
                <th>State</th>
                <th>Publication</th>
                <th>Scheduled (local)</th>
                <th>Result</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${
                posts.length === 0
                  ? html`<tr>
                      <td colspan="7">No posts yet. Sync a Notion database first.</td>
                    </tr>`
                  : null
              }
              ${posts.map((p) =>
                (p.publications.length > 0 ? p.publications : [null]).map(
                  (pub) =>
                    html`<tr>
                      <td>
                        ${p.externalUrl ? html`<a href="${p.externalUrl}" rel="noopener">${p.title}</a>` : p.title}
                        ${p.deletedAt ? html` <em>(deleted in Notion)</em>` : null}
                      </td>
                      <td>${p.sourceStatus ?? '—'}</td>
                      <td>
                        ${p.state}
                        ${
                          Array.isArray(p.validationErrors) && p.validationErrors.length > 0
                            ? html`<br /><small class="error"
                                  >${(p.validationErrors as { message: string }[]).map((e) => e.message).join(' ')}</small
                                >`
                            : null
                        }
                      </td>
                      <td>
                        ${
                          pub
                            ? html`<a href="/w/${ws.id}/publications/${pub.id}">${pub.provider}</a>
                                · ${pub.state}
                                ${pub.attemptNo > 0 ? html`<br /><small>attempt ${pub.attemptNo}, cycle ${pub.cycleNo}</small>` : null}`
                            : '—'
                        }
                      </td>
                      <td>
                        ${pub ? html`${pub.scheduledLocal}<br /><small>${pub.scheduledTz}</small>` : (p.requestedPublishLocal ?? '—')}
                      </td>
                      <td>
                        ${pub?.providerPostUrl ? html`<a href="${pub.providerPostUrl}" rel="noopener">View post</a>` : null}
                        ${pub?.publishedAt ? html`<br /><small>${fmtDate(pub.publishedAt)}${pub.delaySeconds && pub.delaySeconds > 300 ? ` (${Math.round(pub.delaySeconds / 60)} min late)` : ''}</small>` : null}
                        ${pub?.lastErrorMessage ? html`<small class="error">${pub.lastErrorMessage}</small>` : null}
                      </td>
                      <td>
                        ${
                          pub && canAct && pub.state === 'failed'
                            ? html`<form
                                class="inline"
                                method="post"
                                action="/w/${ws.id}/publications/${pub.id}/retry"
                              >
                                <button type="submit">Retry now</button>
                              </form>`
                            : null
                        }
                        ${pub && pub.state === 'ambiguous' ? html`<a href="/w/${ws.id}/publications/${pub.id}">Resolve</a>` : null}
                      </td>
                    </tr>`,
                ),
              )}
            </tbody>
          </table>
        `,
      ),
    );
  });

  app.get(
    '/w/:workspaceId/publications/:publicationId',
    { preHandler: memberPage },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { publicationId } = req.params as { publicationId: string };
      const { notice, error } = req.query as { notice?: string; error?: string };
      const detail = await opts.postQuery.publicationDetail(ctx, publicationId);
      if (!detail)
        return reply
          .status(404)
          .type('text/html')
          .send(layout('Not found', html`<p>Publication not found.</p>`));
      const ws = await opts.workspaces.get(ctx);
      const pub = detail.publication;
      const isAdmin =
        ctx.actor.type === 'user' && (ctx.actor.role === 'owner' || ctx.actor.role === 'admin');
      const canRetry =
        ctx.actor.type === 'user' && ctx.actor.role !== 'viewer' && pub.state === 'failed';
      return reply.type('text/html').send(
        layout(
          `Publication · ${detail.post.title}`,
          html`
            ${pageHeader(req.user!.email, ws.id)}
            <p><a href="/w/${ws.id}/posts">← Posts</a></p>
            <h2>${detail.post.title}</h2>
            ${notice ? html`<p class="notice">${notice}</p>` : null}
            ${error ? html`<p class="notice error">${error}</p>` : null}
            <table>
              <tbody>
                <tr>
                  <th>Publication id</th>
                  <td><code>${pub.id}</code></td>
                </tr>
                <tr>
                  <th>State</th>
                  <td>${pub.state}</td>
                </tr>
                <tr>
                  <th>Account</th>
                  <td>${detail.accountName ?? pub.socialAccountId} (${pub.provider})</td>
                </tr>
                <tr>
                  <th>Scheduled</th>
                  <td>${pub.scheduledLocal} ${pub.scheduledTz} (${fmtDate(pub.scheduledAt)})</td>
                </tr>
                <tr>
                  <th>Published</th>
                  <td>
                    ${fmtDate(pub.publishedAt)}${pub.delaySeconds !== null ? html` · delay ${pub.delaySeconds}s` : null}
                  </td>
                </tr>
                <tr>
                  <th>Provider post</th>
                  <td>
                    ${pub.providerPostUrl ? html`<a href="${pub.providerPostUrl}" rel="noopener">${pub.providerPostUrl}</a>` : (pub.providerPostId ?? '—')}
                  </td>
                </tr>
                <tr>
                  <th>Cycle / attempts</th>
                  <td>${pub.cycleNo} / ${pub.attemptNo} of ${pub.maxAttempts}</td>
                </tr>
                <tr>
                  <th>Last error</th>
                  <td>
                    ${pub.lastErrorCode ? html`<code>${pub.lastErrorCode}</code> ${pub.lastErrorMessage}` : '—'}
                  </td>
                </tr>
                <tr>
                  <th>Notion writeback</th>
                  <td>${pub.writebackState}</td>
                </tr>
                <tr>
                  <th>Notion page</th>
                  <td>
                    ${detail.post.externalUrl ? html`<a href="${detail.post.externalUrl}" rel="noopener">open</a>` : '—'}
                  </td>
                </tr>
              </tbody>
            </table>

            ${
              canRetry
                ? html`<form method="post" action="/w/${ws.id}/publications/${pub.id}/retry">
                    <p><button type="submit">Retry now (new cycle)</button></p>
                  </form>`
                : null
            }
            ${
              pub.state === 'ambiguous' && isAdmin
                ? html`<h3>Resolve</h3>
                    <p class="notice">
                      Check the LinkedIn profile first. If the post is there, mark it published and
                      paste its URL; if not, mark it failed and retry.
                    </p>
                    <form method="post" action="/w/${ws.id}/publications/${pub.id}/resolve">
                      <label
                        ><input type="radio" name="outcome" value="published" required /> Published
                        on LinkedIn</label
                      >
                      <label
                        ><input type="radio" name="outcome" value="failed" /> Not published</label
                      >
                      <label for="providerPostUrl">LinkedIn post URL (if published)</label>
                      <input
                        id="providerPostUrl"
                        name="providerPostUrl"
                        type="url"
                        style="width:100%"
                      />
                      <p><button type="submit">Resolve</button></p>
                    </form>`
                : null
            }

            <h3>Attempts</h3>
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>#</th>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Outcome</th>
                  <th>Error</th>
                  <th>Worker</th>
                </tr>
              </thead>
              <tbody>
                ${
                  pub.attempts.length === 0
                    ? html`<tr>
                        <td colspan="7">No attempts yet.</td>
                      </tr>`
                    : null
                }
                ${pub.attempts.map(
                  (a) =>
                    html`<tr>
                      <td>${a.cycleNo}</td>
                      <td>${a.attemptNo}</td>
                      <td>${fmtDate(a.startedAt)}</td>
                      <td>${fmtDate(a.finishedAt)}</td>
                      <td>${a.outcome ?? 'in flight'}</td>
                      <td>
                        ${a.errorCode ? html`<code>${a.errorCode}</code> ${a.errorMessage}` : ''}
                      </td>
                      <td><small>${a.workerId}</small></td>
                    </tr>`,
                )}
              </tbody>
            </table>

            <h3>Audit trail</h3>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Event</th>
                  <th>From → To</th>
                  <th>Actor</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                ${detail.audit.map(
                  (a) =>
                    html`<tr>
                      <td>${fmtDate(a.occurredAt)}</td>
                      <td>${a.event}</td>
                      <td>${a.fromState ?? ''} → ${a.toState ?? ''}</td>
                      <td>${a.actorType}${a.actorId ? html`:${a.actorId}` : ''}</td>
                      <td>
                        <small><code>${JSON.stringify(a.data)}</code></small>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          `,
        ),
      );
    },
  );

  app.post(
    '/w/:workspaceId/publications/:publicationId/retry',
    { preHandler: [guard, editorPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { publicationId } = req.params as { publicationId: string };
      const back = `/w/${ctx.workspaceId}/publications/${publicationId}`;
      try {
        await opts.publications.retry(ctx, publicationId);
        return reply.redirect(
          `${back}?notice=${encodeURIComponent('Retry scheduled; the worker will publish within a minute.')}`,
        );
      } catch (err) {
        if (err instanceof PublicationError)
          return reply.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
        throw err;
      }
    },
  );

  app.post(
    '/w/:workspaceId/publications/:publicationId/resolve',
    { preHandler: [guard, adminPage] },
    async (req, reply) => {
      const ctx = req.tenant!;
      const { publicationId } = req.params as { publicationId: string };
      const back = `/w/${ctx.workspaceId}/publications/${publicationId}`;
      const parsed = resolveForm.safeParse(req.body);
      if (!parsed.success)
        return reply.redirect(`${back}?error=${encodeURIComponent('Choose an outcome.')}`);
      const url = parsed.data.providerPostUrl?.trim();
      try {
        await opts.publications.resolve(ctx, publicationId, {
          outcome: parsed.data.outcome,
          ...(url ? { providerPostUrl: url, providerPostId: url } : {}),
        });
        return reply.redirect(
          `${back}?notice=${encodeURIComponent(`Resolved as ${parsed.data.outcome}.`)}`,
        );
      } catch (err) {
        if (err instanceof PublicationError)
          return reply.redirect(`${back}?error=${encodeURIComponent(err.message)}`);
        throw err;
      }
    },
  );
};
