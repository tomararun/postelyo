import { createHash, randomBytes } from 'node:crypto';

/**
 * X (Twitter) OAuth 2.0 client, user context with PKCE (Phase 2). Confidential
 * client: the token endpoint is called with HTTP Basic credentials. Access
 * tokens last about two hours; `offline.access` yields a refresh token that
 * the worker uses before publishing. Verify against X's current docs.
 */

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_ME_URL = 'https://api.x.com/2/users/me';
export const X_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'media.write',
  'offline.access',
] as const;

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface XTokens {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  refreshToken?: string;
}

export interface XIdentity {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string;
}

export class XOAuthError extends Error {
  constructor(
    public readonly code: 'exchange_failed' | 'identity_failed' | 'invalid_response' | 'network',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'XOAuthError';
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class XOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: XOAuthConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    const u = new URL(X_AUTHORIZE_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('scope', X_SCOPES.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode(code: string, codeVerifier: string, now = new Date()): Promise<XTokens> {
    return this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.cfg.redirectUri,
        code_verifier: codeVerifier,
        client_id: this.cfg.clientId,
      },
      now,
    );
  }

  async refresh(refreshToken: string, now = new Date()): Promise<XTokens> {
    return this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.cfg.clientId },
      now,
    );
  }

  async fetchIdentity(accessToken: string): Promise<XIdentity> {
    const u = new URL(X_ME_URL);
    u.searchParams.set('user.fields', 'profile_image_url,username,name');
    const res = await this.request(u.toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    const json = await readJson(res);
    if (!res.ok)
      throw new XOAuthError('identity_failed', `X users/me failed (${res.status})`, res.status);
    const data = asRecord(json['data']);
    const id = str(data, 'id');
    const username = str(data, 'username');
    if (!id || !username)
      throw new XOAuthError('invalid_response', 'X users/me missing id/username');
    const image = str(data, 'profile_image_url');
    return {
      id,
      username,
      name: str(data, 'name') ?? username,
      ...(image ? { profileImageUrl: image } : {}),
    };
  }

  private async tokenRequest(fields: Record<string, string>, now: Date): Promise<XTokens> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.request(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(fields),
    });
    const json = await readJson(res);
    if (!res.ok) {
      const desc = str(json, 'error_description') ?? str(json, 'error') ?? res.statusText;
      throw new XOAuthError('exchange_failed', `X token request failed: ${desc}`, res.status);
    }
    const accessToken = str(json, 'access_token');
    const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : undefined;
    if (!accessToken || expiresIn === undefined) {
      throw new XOAuthError('invalid_response', 'X token response missing fields');
    }
    const refreshToken = str(json, 'refresh_token');
    return {
      accessToken,
      expiresAt: new Date(now.getTime() + expiresIn * 1000),
      scopes: (str(json, 'scope') ?? '').split(/[,\s]+/).filter(Boolean),
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new XOAuthError('network', `X request failed: ${(err as Error).message}`);
    }
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
