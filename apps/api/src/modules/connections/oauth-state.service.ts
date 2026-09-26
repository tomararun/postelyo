import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { oauthState } from '../../infra/db/schema.js';
import { uuidv7 } from '../../shared/ids.js';
import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';

export type OAuthProvider = 'linkedin' | 'x' | 'instagram' | 'facebook';
export type OAuthAccountType = 'member' | 'organization';

export interface OAuthStateRow {
  id: string;
  workspaceId: string;
  userId: string;
  provider: OAuthProvider;
  accountType: OAuthAccountType;
  redirectTo: string;
  /** PKCE verifier when the provider uses it (X). */
  pkceVerifier: string | null;
}

const TTL_MS = 10 * 60 * 1000;

/**
 * Single-use OAuth `state` records bound to workspace and user (security.md §5).
 * `consume` is atomic: a state can mint at most one connection.
 */
export class OAuthStateService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    workspaceId: string;
    userId: string;
    provider: OAuthProvider;
    accountType?: OAuthAccountType | undefined;
    redirectTo: string;
    pkceVerifier?: string | undefined;
  }): Promise<string> {
    if (!isSameOriginPath(input.redirectTo))
      throw new Error('redirectTo must be a same-origin path');
    const id = uuidv7();
    await this.db.insert(oauthState).values({
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      accountType: input.accountType ?? 'member',
      redirectTo: input.redirectTo,
      pkceVerifier: input.pkceVerifier ?? null,
      expiresAt: new Date(this.clock.now().getTime() + TTL_MS),
    });
    return id;
  }

  /** Returns the state if valid, unexpired, unconsumed and owned by `userId`; marks it consumed. */
  async consume(
    id: string,
    userId: string,
    provider: OAuthProvider,
  ): Promise<OAuthStateRow | null> {
    const now = this.clock.now();
    const [row] = await this.db
      .update(oauthState)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthState.id, id),
          eq(oauthState.userId, userId),
          eq(oauthState.provider, provider),
          isNull(oauthState.consumedAt),
          gt(oauthState.expiresAt, now),
        ),
      )
      .returning({
        id: oauthState.id,
        workspaceId: oauthState.workspaceId,
        userId: oauthState.userId,
        provider: oauthState.provider,
        accountType: oauthState.accountType,
        redirectTo: oauthState.redirectTo,
        pkceVerifier: oauthState.pkceVerifier,
      });
    if (!row) return null;
    return {
      ...row,
      accountType: row.accountType === 'organization' ? 'organization' : 'member',
    };
  }
}

/** Only relative paths like "/w/abc/connections" are allowed (no open redirects). */
export function isSameOriginPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//') && !/[\r\n\\]/.test(p);
}
