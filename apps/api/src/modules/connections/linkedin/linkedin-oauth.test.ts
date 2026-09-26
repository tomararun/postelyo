import { describe, expect, it } from 'vitest';
import { bodyToString, fakeFetch } from '../../../shared/fetch-utils.js';
import {
  LINKEDIN_ORG_ACLS_URL,
  LINKEDIN_ORGANIZATIONS_URL,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_USERINFO_URL,
  LinkedInOAuthClient,
  LinkedInOAuthError,
} from './linkedin-oauth.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const cfg = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://localhost/oauth/linkedin/callback',
};

describe('LinkedInOAuthClient', () => {
  it('builds the authorization url with state and member scopes', () => {
    const url = new URL(new LinkedInOAuthClient(cfg).authorizationUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(url.toString()).not.toContain('csecret');
  });

  it('exchanges a code with a form-encoded server-to-server request', async () => {
    let seen: { url: string; body: string; ct: string | undefined } | undefined;
    const client = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch((url, init) => {
        seen = {
          url,
          body: bodyToString(init.body),
          ct: (init.headers as Record<string, string>)['content-type'],
        };
        return json(200, {
          access_token: 'AQV-token',
          expires_in: 5184000,
          scope: 'openid,profile,w_member_social',
        });
      }),
    });
    const now = new Date('2026-09-23T00:00:00Z');
    const tokens = await client.exchangeCode('the-code', now);
    expect(seen?.url).toBe(LINKEDIN_TOKEN_URL);
    expect(seen?.ct).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(seen?.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('client_secret')).toBe('csecret');
    expect(tokens.accessToken).toBe('AQV-token');
    expect(tokens.scopes).toEqual(['openid', 'profile', 'w_member_social']);
    expect(tokens.expiresAt.toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('maps exchange errors and malformed responses', async () => {
    const bad = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch(() =>
        json(400, { error: 'invalid_grant', error_description: 'code expired' }),
      ),
    });
    await expect(bad.exchangeCode('x')).rejects.toMatchObject({
      code: 'exchange_failed',
      status: 400,
      message: expect.stringContaining('code expired') as string,
    });

    const malformed = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch(() => json(200, {})),
    });
    await expect(malformed.exchangeCode('x')).rejects.toBeInstanceOf(LinkedInOAuthError);

    const offline = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch(() => {
        throw new Error('ECONNRESET');
      }),
    });
    await expect(offline.exchangeCode('x')).rejects.toMatchObject({ code: 'network' });
  });

  it('requests organization scopes for the page flow', () => {
    const url = new URL(new LinkedInOAuthClient(cfg).authorizationUrl('s', 'organization'));
    expect(url.searchParams.get('scope')).toBe(
      'openid profile r_organization_social w_organization_social rw_organization_admin',
    );
  });

  it('lists administered organizations through the ACL finder and resolves names', async () => {
    const seen: string[] = [];
    const client = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch((url, init) => {
        seen.push(url);
        const headers = init.headers as Record<string, string>;
        expect(headers['authorization']).toBe('Bearer AQV-token');
        expect(headers['linkedin-version']).toMatch(/^\d{6}$/);
        if (url.startsWith(LINKEDIN_ORG_ACLS_URL)) {
          expect(new URL(url).searchParams.get('role')).toBe('ADMINISTRATOR');
          return json(200, {
            elements: [
              { organization: 'urn:li:organization:1001', role: 'ADMINISTRATOR' },
              { organization: 'urn:li:organization:1002', role: 'ADMINISTRATOR' },
              { organization: 'urn:li:organization:1001', role: 'ADMINISTRATOR' },
            ],
          });
        }
        if (url.startsWith(LINKEDIN_ORGANIZATIONS_URL)) {
          expect(url).toContain('ids=List(1001,1002)');
          return json(200, {
            results: {
              '1001': { localizedName: 'Acme Corp', vanityName: 'acme' },
              '1002': { localizedName: 'Acme Labs' },
            },
          });
        }
        return json(404, {});
      }),
    });
    const orgs = await client.fetchAdministeredOrganizations('AQV-token');
    expect(orgs).toEqual([
      { id: '1001', name: 'Acme Corp', vanityName: 'acme' },
      { id: '1002', name: 'Acme Labs' },
    ]);
    expect(seen).toHaveLength(2);

    const none = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch(() => json(200, { elements: [] })),
    });
    expect(await none.fetchAdministeredOrganizations('t')).toEqual([]);
    const denied = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch(() => json(403, { message: 'Not enough permissions' })),
    });
    await expect(denied.fetchAdministeredOrganizations('t')).rejects.toMatchObject({
      code: 'organizations_failed',
      status: 403,
    });
  });

  it('fetches identity with a bearer token', async () => {
    let auth: string | undefined;
    const client = new LinkedInOAuthClient({
      ...cfg,
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toBe(LINKEDIN_USERINFO_URL);
        auth = (init.headers as Record<string, string>)['authorization'];
        return json(200, { sub: 'abc123', name: 'Alice Example', picture: 'https://img/x.jpg' });
      }),
    });
    const id = await client.fetchIdentity('AQV-token');
    expect(auth).toBe('Bearer AQV-token');
    expect(id).toEqual({ sub: 'abc123', name: 'Alice Example', picture: 'https://img/x.jpg' });

    const denied = new LinkedInOAuthClient({ ...cfg, fetchImpl: fakeFetch(() => json(401, {})) });
    await expect(denied.fetchIdentity('bad')).rejects.toMatchObject({ code: 'identity_failed' });
  });
});
