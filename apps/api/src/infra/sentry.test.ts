import { describe, expect, it } from 'vitest';
import { scrubEvent, scrubText } from './sentry.js';

describe('sentry scrubbing', () => {
  it('redacts LinkedIn, Notion, bearer, cookie and query-string secrets', () => {
    const text = [
      'Authorization: Bearer AQVJf9x8Z2kq_abcdefghijklmnop',
      'token AQXyz1234567890abcdefghij in body',
      'notion ntn_abcdefghijklmnopqrstuvwxyz0123',
      'callback?code=abc&access_token=SECRETVALUE&client_secret=SHHH',
      'Cookie: postelyo.session_token=abc.def; Path=/',
    ].join('\n');
    const out = scrubText(text);
    expect(out).not.toContain('AQVJf9x8Z2kq');
    expect(out).not.toContain('AQXyz1234567890');
    expect(out).not.toContain('ntn_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('SECRETVALUE');
    expect(out).not.toContain('SHHH');
    expect(out).not.toContain('abc.def');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('code=abc');
  });

  it('scrubs exception values, breadcrumbs and request data, and drops cookies/auth headers', () => {
    const event = scrubEvent({
      message: 'failed with Bearer AQVsecretsecretsecret',
      exception: { values: [{ value: 'ntn_secretsecretsecretsecret1234 rejected' }] },
      breadcrumbs: [
        { message: 'sent AQVanothersecretvalue1234', data: { url: 'https://x?access_token=zzz' } },
      ],
      request: {
        cookies: { a: 'b' },
        headers: { authorization: 'Bearer x', cookie: 'c', 'user-agent': 'ua' },
        query_string: 'refresh_token=rrr',
        data: 'client_secret=ccc',
      },
    } as never);
    const e = event as {
      message: string;
      exception: { values: { value: string }[] };
      breadcrumbs: { message: string; data: Record<string, string> }[];
      request: {
        cookies?: unknown;
        headers: Record<string, string>;
        query_string: string;
        data: string;
      };
    };
    expect(e.message).not.toContain('AQVsecret');
    expect(e.exception.values[0]!.value).not.toContain('ntn_secret');
    expect(e.breadcrumbs[0]!.message).not.toContain('AQVanother');
    expect(e.breadcrumbs[0]!.data['url']).not.toContain('zzz');
    expect(e.request.cookies).toBeUndefined();
    expect(e.request.headers['authorization']).toBeUndefined();
    expect(e.request.headers['user-agent']).toBe('ua');
    expect(e.request.query_string).not.toContain('rrr');
    expect(e.request.data).not.toContain('ccc');
  });
});
