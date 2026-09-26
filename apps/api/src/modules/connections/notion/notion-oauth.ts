/**
 * Notion public integration OAuth (Phase 3). The user picks the pages to share
 * inside Notion's consent screen; we receive a bot token scoped to that
 * selection. Verify endpoints and response fields against Notion's docs; the
 * integration must pass Notion's review before other workspaces can install it.
 */

export const NOTION_AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
export const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

export interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface NotionOAuthTokens {
  accessToken: string;
  botId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  /** Set when the user chose "use a template" on the consent screen. */
  duplicatedTemplateId: string | null;
}

export class NotionOAuthError extends Error {
  constructor(
    public readonly code: 'exchange_failed' | 'invalid_response' | 'network',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionOAuthError';
  }
}

export class NotionOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: NotionOAuthConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  authorizationUrl(state: string): string {
    const u = new URL(NOTION_AUTHORIZE_URL);
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('owner', 'user');
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<NotionOAuthTokens> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(NOTION_TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.cfg.redirectUri,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NotionOAuthError('network', `Notion request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      json =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const desc = str(json, 'error_description') ?? str(json, 'error') ?? res.statusText;
      throw new NotionOAuthError(
        'exchange_failed',
        `Notion token exchange failed: ${desc}`,
        res.status,
      );
    }
    const accessToken = str(json, 'access_token');
    const botId = str(json, 'bot_id');
    if (!accessToken || !botId) {
      throw new NotionOAuthError('invalid_response', 'Notion token response missing fields');
    }
    return {
      accessToken,
      botId,
      workspaceId: str(json, 'workspace_id') ?? null,
      workspaceName: str(json, 'workspace_name') ?? null,
      workspaceIcon: str(json, 'workspace_icon') ?? null,
      duplicatedTemplateId: str(json, 'duplicated_template_id') ?? null,
    };
  }
}

function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
