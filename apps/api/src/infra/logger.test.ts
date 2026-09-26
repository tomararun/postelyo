import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { REDACT_PATHS } from './logger.js';

describe('logger redaction', () => {
  it('redacts token-shaped fields at any depth', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (s: string) => void lines.push(s) },
    );
    logger.info(
      {
        access_token: 'AQV-secret',
        account: { refresh_token: 'r-secret', credential: 'c' },
        req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
      },
      'publish',
    );
    const out = lines.join('');
    expect(out).not.toContain('AQV-secret');
    expect(out).not.toContain('r-secret');
    expect(out).not.toContain('Bearer x');
    expect(out).not.toContain('sid=1');
    expect(out).toContain('[REDACTED]');
  });
});
