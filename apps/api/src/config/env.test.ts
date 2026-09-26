import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvError, linkedInConfig, loadEnv } from './env.js';

const base = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
};

const prod = {
  ...base,
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://app.example.com',
  ALERT_EMAIL: 'ops@example.com',
  MAIL_TRANSPORT: 'smtp',
  SMTP_URL: 'smtp://mail.example.com:587',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.PROVIDER_MODE).toBe('fake');
    expect(env.MAIL_TRANSPORT).toBe('log');
    expect(env.ALERT_EMAIL).toBeUndefined();
    expect(linkedInConfig(env)).toBeNull();
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({ ...base, ALERT_EMAIL: '', LOG_LEVEL: '' });
    expect(env.ALERT_EMAIL).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('rejects a missing database url with a readable error', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(EnvError);
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects bad secrets and keys', () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(EnvError);
    expect(() => loadEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(() => loadEnv({ ...base, ENCRYPTION_KEYS: 'k1:tooshort' })).toThrow(/ENCRYPTION_KEYS/);
  });

  it('requires SMTP_URL when the smtp transport is selected', () => {
    expect(() => loadEnv({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL/);
  });

  it('requires LinkedIn id and secret together', () => {
    expect(() => loadEnv({ ...base, LINKEDIN_CLIENT_ID: 'id' })).toThrow(/set both or neither/);
    const env = loadEnv({ ...base, LINKEDIN_CLIENT_ID: 'id', LINKEDIN_CLIENT_SECRET: 's' });
    expect(linkedInConfig(env)).toEqual({ clientId: 'id', clientSecret: 's' });
  });

  it('enforces production requirements', () => {
    expect(loadEnv(prod).NODE_ENV).toBe('production');
    expect(() => loadEnv({ ...prod, ALERT_EMAIL: '' })).toThrow(/ALERT_EMAIL/);
    expect(() => loadEnv({ ...prod, MAIL_TRANSPORT: 'log' })).toThrow(/MAIL_TRANSPORT/);
    expect(() => loadEnv({ ...prod, APP_BASE_URL: 'http://app.example.com' })).toThrow(/https/);
    expect(() => loadEnv({ ...prod, PROVIDER_MODE: 'live' })).toThrow(/LINKEDIN_CLIENT_ID/);
  });
});
