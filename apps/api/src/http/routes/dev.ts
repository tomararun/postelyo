import type { FastifyPluginAsync } from 'fastify';
import { LogMailer } from '../../infra/mailer.js';

export interface DevRoutesOptions {
  mailer: LogMailer;
}

/**
 * Local development only (D67): the latest sign-in link "sent" to an address, so the
 * dashboard can show it instead of asking the developer to dig through the api log.
 * Registered only when NODE_ENV=development and MAIL_TRANSPORT=log; production
 * configuration already refuses the log transport, so this route cannot exist there.
 */
export const devRoutes: FastifyPluginAsync<DevRoutesOptions> = async (app, opts) => {
  app.get('/v1/dev/magic-link', async (req, reply) => {
    const { email } = req.query as { email?: string };
    const to = (email ?? '').trim().toLowerCase();
    const mail = to ? opts.mailer.lastTo(to) : undefined;
    const url = mail?.text.match(/https?:\/\/\S+\/api\/auth\/magic-link\/verify\?\S+/)?.[0];
    if (!url) return reply.status(404).send({ url: null });
    return { url };
  });
};

/** True when the dev-only routes may be mounted. */
export function devRoutesAllowed(
  env: { NODE_ENV: string; MAIL_TRANSPORT: string },
  mailer: unknown,
): mailer is LogMailer {
  return (
    env.NODE_ENV === 'development' && env.MAIL_TRANSPORT === 'log' && mailer instanceof LogMailer
  );
}
