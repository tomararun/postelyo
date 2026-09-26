/**
 * LinkedIn OAuth 2.0 client for personal-profile and organization-page
 * publishing (architecture §6.2, P1 + Phase 1). Pure HTTP translator: no
 * database, no state. `fetchImpl` is injectable for tests.
 *
 * Endpoints and scopes must be re-verified against LinkedIn's current docs at
 * release time; they are isolated here so a change touches one file.
 */

export const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
/** Community Management API: organizations the member administers (needs product approval). */
export const LINKEDIN_ORG_ACLS_URL = 'https://api.linkedin.com/rest/organizationAcls';
export const LINKEDIN_ORGANIZATIONS_URL = 'https://api.linkedin.com/rest/organizations';
/** Monthly LinkedIn-Version pin for the REST endpoints used here; keep in step with the publishing adapter. */
export const LINKEDIN_API_VERSION = '202509';

/** Self-serve "Sign In with LinkedIn (OpenID Connect)" + "Share on LinkedIn" products. */
export const LINKEDIN_MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'] as const;
/**
 * Organization pages (Community Management API, approval required):
 * `rw_organization_admin` lists administered organizations,
 * `w_organization_social` posts as the organization, `r_organization_social` reads its posts.
 */
export const LINKEDIN_ORGANIZATION_SCOPES = [
  'openid',
  'profile',
  'r_organization_social',
  'w_organization_social',
  'rw_organization_admin',
] as const;

export type LinkedInAccountType = 'member' | 'organization';

export interface LinkedInOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  version?: string;
}

export interface LinkedInTokens {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
}

export interface LinkedInIdentity {
  /** OpenID `sub`; the member id used in `urn:li:person:{sub}`. */
  sub: string;
  name: string;
  picture?: string;
  email?: string;
}

export interface LinkedInOrganization {
  /** Numeric id used in `urn:li:organization:{id}`. */
  id: string;
  name: string;
  vanityName?: string;
  logoUrl?: string;
}

export type LinkedInOAuthErrorCode =
  'exchange_failed' | 'identity_failed' | 'organizations_failed' | 'invalid_response' | 'network';

export class LinkedInOAuthError extends Error {
  constructor(
    public readonly code: LinkedInOAuthErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LinkedInOAuthError';
  }
}

export class LinkedInOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly version: string;

  constructor(private readonly cfg: LinkedInOAuthConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.version = cfg.version ?? LINKEDIN_API_VERSION;
  }

  authorizationUrl(state: string, accountType: LinkedInAccountType = 'member'): string {
    const scopes =
      accountType === 'organization' ? LINKEDIN_ORGANIZATION_SCOPES : LINKEDIN_MEMBER_SCOPES;
    const u = new URL(LINKEDIN_AUTHORIZE_URL);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('scope', scopes.join(' '));
    return u.toString();
  }

  async exchangeCode(code: string, now: Date = new Date()): Promise<LinkedInTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.redirectUri,
    });
    const res = await this.request(LINKEDIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const json = await readJson(res);
    if (!res.ok) {
      const desc =
        pickString(json, 'error_description') ?? pickString(json, 'error') ?? res.statusText;
      throw new LinkedInOAuthError(
        'exchange_failed',
        `LinkedIn token exchange failed: ${desc}`,
        res.status,
      );
    }
    const accessToken = pickString(json, 'access_token');
    const expiresIn = pickNumber(json, 'expires_in');
    if (!accessToken || expiresIn === undefined) {
      throw new LinkedInOAuthError('invalid_response', 'LinkedIn token response missing fields');
    }
    const scopes = (pickString(json, 'scope') ?? '').split(/[,\s]+/).filter(Boolean);
    const refreshToken = pickString(json, 'refresh_token');
    const refreshIn = pickNumber(json, 'refresh_token_expires_in');
    return {
      accessToken,
      expiresAt: new Date(now.getTime() + expiresIn * 1000),
      scopes,
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshToken && refreshIn !== undefined
        ? { refreshTokenExpiresAt: new Date(now.getTime() + refreshIn * 1000) }
        : {}),
    };
  }

  async fetchIdentity(accessToken: string): Promise<LinkedInIdentity> {
    const res = await this.request(LINKEDIN_USERINFO_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    const json = await readJson(res);
    if (!res.ok) {
      throw new LinkedInOAuthError(
        'identity_failed',
        `LinkedIn userinfo failed (${res.status})`,
        res.status,
      );
    }
    const sub = pickString(json, 'sub');
    if (!sub) throw new LinkedInOAuthError('invalid_response', 'LinkedIn userinfo missing sub');
    const composed = [pickString(json, 'given_name'), pickString(json, 'family_name')]
      .filter(Boolean)
      .join(' ');
    const name = pickString(json, 'name') ?? (composed.length > 0 ? composed : 'LinkedIn member');
    const picture = pickString(json, 'picture');
    const email = pickString(json, 'email');
    return { sub, name, ...(picture ? { picture } : {}), ...(email ? { email } : {}) };
  }

  /**
   * Organizations the member administers (role ADMINISTRATOR, state APPROVED),
   * resolved to names. Requires `rw_organization_admin`; verify the finder and
   * projection against the current Community Management API docs.
   */
  async fetchAdministeredOrganizations(accessToken: string): Promise<LinkedInOrganization[]> {
    const acls = new URL(LINKEDIN_ORG_ACLS_URL);
    acls.searchParams.set('q', 'roleAssignee');
    acls.searchParams.set('role', 'ADMINISTRATOR');
    acls.searchParams.set('state', 'APPROVED');
    acls.searchParams.set('count', '50');
    const res = await this.request(acls.toString(), {
      method: 'GET',
      headers: this.restHeaders(accessToken),
    });
    const json = await readJson(res);
    if (!res.ok) {
      throw new LinkedInOAuthError(
        'organizations_failed',
        `LinkedIn organization lookup failed (${res.status}): ${pickString(json, 'message') ?? res.statusText}`,
        res.status,
      );
    }
    const elements = Array.isArray(json['elements']) ? json['elements'] : [];
    const ids = [
      ...new Set(
        elements
          .map((e) => pickString(asRecord(e), 'organization') ?? '')
          .map((urn) => urn.replace(/^urn:li:organization:/, ''))
          .filter((id) => /^\d+$/.test(id)),
      ),
    ];
    if (ids.length === 0) return [];

    // Batch get: /rest/organizations?ids=List(1,2,3)
    const orgs = await this.request(`${LINKEDIN_ORGANIZATIONS_URL}?ids=List(${ids.join(',')})`, {
      method: 'GET',
      headers: this.restHeaders(accessToken),
    });
    const orgJson = await readJson(orgs);
    if (!orgs.ok) {
      throw new LinkedInOAuthError(
        'organizations_failed',
        `LinkedIn organization details failed (${orgs.status})`,
        orgs.status,
      );
    }
    const results = asRecord(orgJson['results']);
    return ids.map((id) => {
      const org = asRecord(results[id]);
      const name = pickString(org, 'localizedName') ?? pickString(org, 'name') ?? `Page ${id}`;
      const vanityName = pickString(org, 'vanityName');
      return { id, name, ...(vanityName ? { vanityName } : {}) };
    });
  }

  private restHeaders(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'linkedin-version': this.version,
      'x-restli-protocol-version': '2.0.0',
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new LinkedInOAuthError('network', `LinkedIn request failed: ${(err as Error).message}`);
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

function pickString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function pickNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
