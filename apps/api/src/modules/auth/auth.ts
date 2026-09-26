import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import type { Env } from '../../config/env.js';
import type { Db } from '../../infra/db/client.js';
import * as schema from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import { uuidv7 } from '../../shared/ids.js';

export interface AuthDeps {
  db: Db;
  env: Pick<Env, 'APP_BASE_URL' | 'AUTH_SECRET' | 'NODE_ENV'>;
  mailer: Mailer;
  logger: Logger;
  /** Called after Better Auth inserts a new user (first sign-in). Must be idempotent. */
  onUserCreated: (user: { id: string; email: string; name: string }) => Promise<void>;
}

const SESSION_DAYS = 30;

/**
 * Better Auth instance (architecture §5.1, security.md §3): magic-link only,
 * server-side sessions in Postgres, HttpOnly cookies, ids from our uuidv7.
 */
export function createAuth(deps: AuthDeps) {
  const secure = deps.env.APP_BASE_URL.startsWith('https://');
  return betterAuth({
    appName: 'Postelyo',
    baseURL: deps.env.APP_BASE_URL,
    basePath: '/api/auth',
    secret: deps.env.AUTH_SECRET,
    trustedOrigins: [deps.env.APP_BASE_URL],
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: 'postelyo',
      database: { generateId: () => uuidv7() },
    },
    rateLimit: { enabled: deps.env.NODE_ENV !== 'test' },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              await deps.onUserCreated({ id: user.id, email: user.email, name: user.name });
            } catch (err) {
              // Sign-in must not fail because provisioning did; the home page re-runs it.
              deps.logger.error({ err, userId: user.id }, 'post-signup provisioning failed');
            }
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await deps.mailer.send({
            to: email,
            subject: 'Sign in to Postelyo',
            text: `Sign in to Postelyo by opening this link (valid for 15 minutes):\n\n${url}\n\nIf you did not request this, ignore this email.`,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Resolve the signed-in user from request headers, or null. Never throws for a missing session. */
export async function getSessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  return { id: result.user.id, email: result.user.email, name: result.user.name };
}
