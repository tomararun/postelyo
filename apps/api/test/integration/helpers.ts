import { tmpdir } from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';
import { pino } from 'pino';
import { eq } from 'drizzle-orm';
import type { Env } from '../../src/config/env.js';
import { workspace } from '../../src/infra/db/schema.js';
import { EnvKeyProvider } from '../../src/infra/crypto/key-provider.js';
import { createDb } from '../../src/infra/db/client.js';
import { LogMailer } from '../../src/infra/mailer.js';
import { buildServer } from '../../src/http/server.js';
import type { App } from '../../src/http/app.js';
import { RecordingEnqueuer, type JobEnqueuer } from '../../src/modules/publishing/jobs.js';
import { buildServices, type Services } from '../../src/services.js';
import type { BillingGateway } from '../../src/modules/billing/gateway.js';
import type { AiProvider } from '../../src/modules/ai/provider.js';
import type { Clock } from '../../src/shared/clock.js';

export const TEST_ENCRYPTION_KEYS = 'k1:' + Buffer.alloc(32, 7).toString('base64');

export const testEnv: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: 0,
  APP_BASE_URL: 'http://localhost',
  DATABASE_URL: '',
  AUTH_SECRET: 'test-secret-test-secret-test-secret-0000',
  ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
  PROVIDER_MODE: 'fake',
  REGION: 'us',
  MAIL_TRANSPORT: 'log',
  MAIL_FROM: 'Postelyo <test@postelyo.local>',
  ALERT_EMAIL: 'ops@example.com',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: path.join(tmpdir(), 'postelyo-media-test'),
};

/** Real-time clock that tests can advance without waiting. */
export class TestClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface TestStack {
  app: App;
  mailer: LogMailer;
  db: ReturnType<typeof createDb>;
  keyProvider: EnvKeyProvider;
  services: Services;
  enqueue: RecordingEnqueuer;
  clock: TestClock;
  close: () => Promise<void>;
  /** Runs the full magic-link flow and returns the session cookie header value. */
  signIn: (email: string) => Promise<string>;
  /** Signs in and returns the cookie plus the user's default workspace id. */
  signInWithWorkspace: (email: string) => Promise<{ cookie: string; workspaceId: string }>;
  /** Operator-granted plan (Phase 3): raises the limits of a workspace with no subscription. */
  grantPlan: (
    workspaceId: string,
    plan: 'free' | 'solo' | 'team' | 'agency' | 'enterprise',
  ) => Promise<void>;
}

export interface TestStackOptions {
  env?: Partial<Env>;
  fetchImpl?: typeof fetch;
  enqueue?: JobEnqueuer;
  workerId?: string;
  /** Phase 3: stub Stripe Checkout/Portal; the webhook path is exercised with signed events. */
  billingGateway?: BillingGateway;
  /** Phase 6: inject the fake AI provider. */
  aiProvider?: AiProvider;
}

export async function createTestStack(opts: TestStackOptions = {}): Promise<TestStack> {
  const url = inject('databaseUrl');
  const db = createDb(url, { max: 6 });
  const mailer = new LogMailer();
  const keyProvider = EnvKeyProvider.fromEnv(TEST_ENCRYPTION_KEYS);
  const env = { ...testEnv, ...opts.env, DATABASE_URL: url };
  const logger = pino({ level: 'silent' });
  const clock = new TestClock();
  const enqueue = new RecordingEnqueuer();
  const services = buildServices({
    env,
    db: db.db,
    logger,
    keyProvider,
    mailer,
    enqueue: opts.enqueue ?? enqueue,
    workerId: opts.workerId ?? 'test-worker',
    fetchImpl: opts.fetchImpl,
    clock,
    random: () => 0.5,
    ...(opts.billingGateway ? { billingGateway: opts.billingGateway } : {}),
    ...(opts.aiProvider ? { aiProvider: opts.aiProvider } : {}),
  });
  const app = await buildServer({
    env,
    logger,
    db: db.db,
    mailer,
    keyProvider,
    services,
    readiness: async () => ({ db: await db.ping() }),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  await app.ready();

  const signIn = async (email: string): Promise<string> => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'content-type': 'application/json', origin: testEnv.APP_BASE_URL },
      payload: { email, callbackURL: '/' },
    });
    if (start.statusCode !== 200)
      throw new Error(`magic link request failed: ${start.statusCode} ${start.body}`);
    const mail = mailer.lastTo(email);
    const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw new Error('no magic link in mail');
    const verify = await app.inject({
      method: 'GET',
      url: new URL(link).pathname + new URL(link).search,
    });
    const setCookie = verify.headers['set-cookie'];
    const cookies = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []).map(
      (c) => c.split(';')[0] ?? '',
    );
    if (cookies.length === 0)
      throw new Error(`no session cookie after verify: ${verify.statusCode} ${verify.body}`);
    return cookies.join('; ');
  };

  const signInWithWorkspace = async (email: string) => {
    const cookie = await signIn(email);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    const workspaceId = me.json<{ workspaces: { id: string }[] }>().workspaces[0]?.id;
    if (!workspaceId) throw new Error('no default workspace');
    return { cookie, workspaceId };
  };

  return {
    app,
    mailer,
    db,
    keyProvider,
    services,
    enqueue,
    clock,
    signIn,
    signInWithWorkspace,
    grantPlan: async (workspaceId, plan) => {
      await db.db.update(workspace).set({ plan }).where(eq(workspace.id, workspaceId));
    },
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** Cookie-jar-free helper: extracts a redirect location's path+query. */
export function locationOf(res: { headers: Record<string, unknown> }): string {
  const loc = res.headers['location'];
  if (typeof loc !== 'string') throw new Error('no location header');
  return loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
}

/** Polls until `check` returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}
