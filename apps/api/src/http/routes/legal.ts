import type { FastifyPluginAsync } from 'fastify';
import { html, layout } from '../views/html.js';

/**
 * Privacy policy and terms (Phase 3). Placeholder wording marked for legal
 * review; the operator replaces it before public launch. Served unauthenticated.
 */
export const PRIVACY_TEXT = [
  'Postelyo stores the content you schedule, the results of publishing it, the social accounts you connect (access tokens encrypted at rest) and the Notion integration token you provide, in order to publish on your behalf and report back.',
  'We do not sell data. Tokens are decrypted only inside the background worker at publish time and never shown in the interface or logs.',
  'Deleting a workspace removes its content, connections and tokens; anonymised audit records are retained for security purposes.',
  'Contact: privacy@postelyo.example (placeholder).',
];

export const TERMS_TEXT = [
  'Postelyo publishes content to third-party platforms on your instruction. You are responsible for the content and for complying with each platform’s terms (LinkedIn, X, Meta).',
  'The service is provided as is during the pilot. Availability targets and support terms will be published with paid plans.',
  'Plan limits are enforced as described on the Billing page; downgrades take effect after the current period or a grace period after failed payment.',
  'Contact: legal@postelyo.example (placeholder).',
];

export const legalRoutes: FastifyPluginAsync = async (app) => {
  const page = (title: string, paragraphs: string[]) =>
    layout(
      title,
      html`<header><h1>Postelyo</h1></header>
        <h2>${title}</h2>
        <p class="notice"><small>Placeholder text pending legal review.</small></p>
        ${paragraphs.map((p) => html`<p>${p}</p>`)}`,
    );
  app.get('/privacy', async (_req, reply) =>
    reply.type('text/html').send(page('Privacy policy', PRIVACY_TEXT)),
  );
  app.get('/terms', async (_req, reply) =>
    reply.type('text/html').send(page('Terms of service', TERMS_TEXT)),
  );
};
