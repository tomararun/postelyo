import { z } from 'zod';
import { parseEncryptionKeys } from '../infra/crypto/key-provider.js';

/**
 * Environment configuration. Validated once at boot; the process fails fast on
 * a missing or malformed value (architecture §13). Secrets are never logged.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.url(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Signing/encryption secret for sessions and magic links (>= 32 chars). */
  AUTH_SECRET: z.string().min(32),
  /** Master keys for credential envelope encryption: "id:base64,..." — first is current. */
  ENCRYPTION_KEYS: z.string().refine(
    (v) => {
      try {
        parseEncryptionKeys(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'expected "<id>:<base64 32 bytes>" entries, comma-separated' },
  ),
  /** fake = FakeProvider only; live = real provider adapters. */
  PROVIDER_MODE: z.enum(['fake', 'live']).default('fake'),
  /** LinkedIn OAuth app. Both or neither; required when PROVIDER_MODE=live in production. */
  LINKEDIN_CLIENT_ID: z.string().min(1).optional(),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Notion webhook verification token (architecture §11.1). Notion sends it once
   * when the subscription is created; unset = inbound webhooks are ignored.
   */
  NOTION_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Operational alert recipient (product decision P5). Required in production. */
  ALERT_EMAIL: z.email().optional(),
  /** log = print emails to the log (dev/test); smtp = deliver via SMTP_URL. */
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  MAIL_FROM: z.string().min(3).default('Postelyo <no-reply@postelyo.local>'),
  SENTRY_DSN: z.url().optional(),
  /** When set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Reported in heartbeats and logs (set by the deploy pipeline). */
  APP_VERSION: z.string().min(1).optional(),
  /** Stable identifier for this process, used as lease owner and in logs. */
  INSTANCE_ID: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings as unset so `ALERT_EMAIL=` in .env means "not configured".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const env = result.data;
  const issues: string[] = [];
  if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
    issues.push('SMTP_URL: required when MAIL_TRANSPORT=smtp');
  }
  if (Boolean(env.LINKEDIN_CLIENT_ID) !== Boolean(env.LINKEDIN_CLIENT_SECRET)) {
    issues.push('LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET: set both or neither');
  }
  if (env.NODE_ENV === 'production') {
    if (!env.ALERT_EMAIL) issues.push('ALERT_EMAIL: required in production');
    if (env.MAIL_TRANSPORT !== 'smtp') issues.push('MAIL_TRANSPORT: must be smtp in production');
    if (!env.APP_BASE_URL.startsWith('https://')) {
      issues.push('APP_BASE_URL: must be https in production');
    }
    if (env.PROVIDER_MODE === 'live' && !env.LINKEDIN_CLIENT_ID) {
      issues.push('LINKEDIN_CLIENT_ID: required when PROVIDER_MODE=live in production');
    }
  }
  if (issues.length > 0) throw new EnvError(issues);
  return env;
}

/** LinkedIn OAuth config, or null when the app is not configured (connect button disabled). */
export function linkedInConfig(env: Env): { clientId: string; clientSecret: string } | null {
  return env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET
    ? { clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET }
    : null;
}
