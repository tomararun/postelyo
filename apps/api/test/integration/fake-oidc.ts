import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { bodyToString } from '../../src/shared/fetch-utils.js';

/**
 * Minimal OpenID Connect provider for the SSO tests: discovery, JWKS, token
 * endpoint (authorization code → signed id_token) and userinfo. The test sets
 * `nextNonce` from the authorize redirect before exchanging the code, exactly
 * as a browser round trip would carry it.
 */
export class FakeOidcProvider {
  readonly issuer: string;
  readonly clientId = 'postelyo-client';
  readonly clientSecret = 'postelyo-client-secret';
  /** Nonce the next id_token carries (from the authorize URL). */
  nextNonce = '';
  /** Email and name of the user who "logged in". */
  subject = { email: 'alice@example.com', name: 'Alice Example', sub: 'user-1' };
  /** Recorded token requests (form fields). */
  readonly tokenRequests: Record<string, string>[] = [];
  /** When set, the token endpoint answers with this error. */
  tokenError: string | null = null;
  private keys: { privateKey: CryptoKey; jwk: Record<string, unknown> } | null = null;

  constructor(issuer = 'https://idp.example.test') {
    this.issuer = issuer;
  }

  private async ready() {
    if (!this.keys) {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
      this.keys = { privateKey, jwk };
    }
    return this.keys;
  }

  /** Returns a Response for URLs belonging to the provider, otherwise null. */
  async handle(url: string, init: RequestInit): Promise<Response | null> {
    if (!url.startsWith(this.issuer)) return null;
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
      });
    }
    if (path === '/jwks') {
      const { jwk } = await this.ready();
      return json(200, { keys: [jwk] });
    }
    if (path === '/token') {
      const form = Object.fromEntries(new URLSearchParams(bodyToString(init.body)));
      this.tokenRequests.push(form);
      if (this.tokenError) return json(400, { error: this.tokenError });
      if (form['client_secret'] !== this.clientSecret)
        return json(401, { error: 'invalid_client' });
      if (form['code'] !== 'good-code') return json(400, { error: 'invalid_grant' });
      const { privateKey } = await this.ready();
      const idToken = await new SignJWT({
        email: this.subject.email,
        name: this.subject.name,
        nonce: this.nextNonce,
        email_verified: true,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.issuer)
        .setAudience(this.clientId)
        .setSubject(this.subject.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { access_token: 'at-1', token_type: 'Bearer', id_token: idToken });
    }
    if (path === '/userinfo')
      return json(200, { sub: this.subject.sub, email: this.subject.email });
    return json(404, { error: 'not_found' });
  }
}
