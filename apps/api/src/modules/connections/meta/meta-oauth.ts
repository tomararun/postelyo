/**
 * Meta (Facebook Login) OAuth client for Facebook Pages and Instagram
 * professional accounts (Phase 2). The user token is exchanged for a
 * long-lived one, then each administered Page yields its own Page access
 * token (which does not expire when derived from a long-lived user token) and
 * optionally a linked Instagram account that uses the same Page token. Needs
 * app review for `pages_manage_posts` and `instagram_content_publish`; verify
 * fields against the current Graph API docs.
 */

export const META_GRAPH_VERSION = 'v21.0';
export const META_AUTHORIZE_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
export const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
] as const;

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  graphUrl?: string;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  pictureUrl?: string;
  instagram?: { id: string; username: string; pictureUrl?: string };
}

export class MetaOAuthError extends Error {
  constructor(
    public readonly code: 'exchange_failed' | 'pages_failed' | 'invalid_response' | 'network',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'MetaOAuthError';
  }
}

export class MetaOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly graphUrl: string;

  constructor(private readonly cfg: MetaOAuthConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.graphUrl = cfg.graphUrl ?? META_GRAPH_URL;
  }

  authorizationUrl(state: string): string {
    const u = new URL(META_AUTHORIZE_URL);
    u.searchParams.set('client_id', this.cfg.appId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', META_SCOPES.join(','));
    return u.toString();
  }

  /** Code → short-lived user token → long-lived user token (about 60 days). */
  async exchangeCode(
    code: string,
    now = new Date(),
  ): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const short = new URL(`${this.graphUrl}/oauth/access_token`);
    short.searchParams.set('client_id', this.cfg.appId);
    short.searchParams.set('client_secret', this.cfg.appSecret);
    short.searchParams.set('redirect_uri', this.cfg.redirectUri);
    short.searchParams.set('code', code);
    const first = await this.getJson(
      short.toString(),
      'exchange_failed',
      'Meta code exchange failed',
    );
    const shortToken = str(first, 'access_token');
    if (!shortToken)
      throw new MetaOAuthError('invalid_response', 'Meta token response missing access_token');

    const long = new URL(`${this.graphUrl}/oauth/access_token`);
    long.searchParams.set('grant_type', 'fb_exchange_token');
    long.searchParams.set('client_id', this.cfg.appId);
    long.searchParams.set('client_secret', this.cfg.appSecret);
    long.searchParams.set('fb_exchange_token', shortToken);
    const second = await this.getJson(
      long.toString(),
      'exchange_failed',
      'Meta long-lived token exchange failed',
    );
    const accessToken = str(second, 'access_token') ?? shortToken;
    const expiresIn = typeof second['expires_in'] === 'number' ? second['expires_in'] : null;
    return {
      accessToken,
      expiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000) : null,
    };
  }

  /** Pages the user manages, each with its Page token and linked Instagram account. */
  async fetchPages(userAccessToken: string): Promise<MetaPage[]> {
    const u = new URL(`${this.graphUrl}/me/accounts`);
    u.searchParams.set(
      'fields',
      'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
    );
    u.searchParams.set('limit', '100');
    u.searchParams.set('access_token', userAccessToken);
    const json = await this.getJson(u.toString(), 'pages_failed', 'Meta pages lookup failed');
    const data = json['data'];
    const out: MetaPage[] = [];
    for (const raw of Array.isArray(data) ? data : []) {
      const p = asRecord(raw);
      const id = str(p, 'id');
      const accessToken = str(p, 'access_token');
      if (!id || !accessToken) continue;
      const ig = asRecord(p['instagram_business_account']);
      const igId = str(ig, 'id');
      const igUser = str(ig, 'username');
      const pictureUrl = str(asRecord(asRecord(p['picture'])['data']), 'url');
      out.push({
        id,
        name: str(p, 'name') ?? `Page ${id}`,
        accessToken,
        ...(pictureUrl ? { pictureUrl } : {}),
        ...(igId && igUser
          ? {
              instagram: {
                id: igId,
                username: igUser,
                ...(str(ig, 'profile_picture_url')
                  ? { pictureUrl: str(ig, 'profile_picture_url')! }
                  : {}),
              },
            }
          : {}),
      });
    }
    return out;
  }

  private async getJson(
    url: string,
    code: 'exchange_failed' | 'pages_failed',
    label: string,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MetaOAuthError('network', `Meta request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = asRecord(JSON.parse(text));
    } catch {
      json = {};
    }
    if (!res.ok) {
      const message = str(asRecord(json['error']), 'message') ?? res.statusText;
      throw new MetaOAuthError(code, `${label}: ${message}`, res.status);
    }
    return json;
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
