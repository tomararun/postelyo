import * as Sentry from '@sentry/node';
import type { Env } from '../config/env.js';

/**
 * Error reporting (architecture §19, security.md §7). Every event passes
 * through `scrubText` so tokens never leave the process.
 */

/** `keepKey` patterns are `key=value` or `Bearer value`: the key survives, the value is redacted. */
const TOKEN_PATTERNS: { re: RegExp; keepKey: boolean }[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, keepKey: true },
  { re: /\bAQ[A-Za-z0-9_-]{16,}/g, keepKey: false }, // LinkedIn access tokens
  { re: /\bntn_[A-Za-z0-9]{20,}/g, keepKey: false }, // Notion integration tokens
  { re: /\bsecret_[A-Za-z0-9]{20,}/g, keepKey: false }, // legacy Notion tokens
  { re: /\b(?:access|refresh|id)_token=[^&\s"';]+/gi, keepKey: true },
  { re: /\b(?:client_secret|password|token)=[^&\s"';]+/gi, keepKey: true },
  { re: /postelyo\.session_token=[^;\s"']+/g, keepKey: true },
];

export function scrubText(text: string): string {
  let out = text;
  for (const { re, keepKey } of TOKEN_PATTERNS) {
    out = out.replace(re, (m) => (keepKey ? `${m.split(/[=\s]/)[0]}=[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = scrubText(b.message);
    if (b.data) {
      for (const [k, v] of Object.entries(b.data)) {
        if (typeof v === 'string') b.data[k] = scrubText(v);
      }
    }
  }
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = scrubText(event.request.query_string);
    }
    if (typeof event.request.data === 'string') event.request.data = scrubText(event.request.data);
  }
  return event;
}

export function initSentry(
  env: Pick<Env, 'SENTRY_DSN' | 'NODE_ENV' | 'APP_VERSION'>,
  service: 'api' | 'worker',
): boolean {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.APP_VERSION,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    initialScope: { tags: { service } },
  });
  return true;
}

/** Reports an operational error with context tags; no-op when Sentry is not initialised. */
export function reportError(
  err: unknown,
  context: Record<string, string | number | null | undefined> = {},
): void {
  if (!Sentry.isInitialized()) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) {
      if (v !== undefined && v !== null) scope.setTag(k, String(v));
    }
    Sentry.captureException(err);
  });
}
