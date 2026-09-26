import { pino, type Logger } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Paths redacted from every log line (security.md §7). Keep this list in sync
 * with the release checklist; the redaction test asserts on it.
 */
export const REDACT_PATHS = [
  'authorization',
  'cookie',
  'set-cookie',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'token',
  '*.token',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'client_secret',
  '*.client_secret',
  'credential',
  '*.credential',
  'DATABASE_URL',
  'ENCRYPTION_KEYS',
  '*.password',
];

export type { Logger };

export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV' | 'INSTANCE_ID'>,
  service: 'api' | 'worker',
): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service, instance: env.INSTANCE_ID ?? null },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
