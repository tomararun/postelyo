import type { Db } from '../../../infra/db/client.js';
import type { Logger } from '../../../infra/logger.js';
import { recordAudit } from '../../audit/audit.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { OAuthStateService } from '../oauth-state.service.js';
import { ConnectionError, type SocialAccountService } from '../social-account.service.js';
import { XOAuthError, pkcePair, type XOAuthClient } from './x-oauth.js';

export interface XConnectDeps {
  db: Db;
  logger: Logger;
  client: XOAuthClient;
  socialAccounts: SocialAccountService;
  states: OAuthStateService;
  returnPath: (workspaceId: string) => string;
}

export type XCallbackOutcome =
  | { ok: true; workspaceId: string; redirectTo: string }
  | { ok: false; redirectTo: string; reason: string };

/** X OAuth 2.0 (PKCE) connect flow (Phase 2); one X profile per callback, any number per workspace. */
export class XConnectFlow {
  constructor(private readonly deps: XConnectDeps) {}

  async start(ctx: TenantContext, userId: string): Promise<string> {
    const { verifier, challenge } = pkcePair();
    const state = await this.deps.states.create({
      workspaceId: ctx.workspaceId,
      userId,
      provider: 'x',
      accountType: 'member',
      redirectTo: this.deps.returnPath(ctx.workspaceId),
      pkceVerifier: verifier,
    });
    return this.deps.client.authorizationUrl(state, challenge);
  }

  async callback(input: {
    userId: string;
    correlationId: string;
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
  }): Promise<XCallbackOutcome> {
    const stateRow = input.state
      ? await this.deps.states.consume(input.state, input.userId, 'x')
      : null;
    if (!stateRow || !stateRow.pkceVerifier) {
      await recordAudit(this.deps.db, {
        workspaceId: null,
        actor: { type: 'user', id: input.userId, role: 'viewer' },
        entityType: 'oauth_state',
        entityId: input.state ?? 'missing',
        event: 'oauth.state_mismatch',
        correlationId: input.correlationId,
        data: { provider: 'x' },
      });
      return {
        ok: false,
        redirectTo: '/',
        reason: 'The X sign-in link was invalid or expired. Please try again.',
      };
    }
    const ctx: TenantContext = {
      workspaceId: stateRow.workspaceId,
      actor: { type: 'user', id: input.userId, role: 'admin' },
      correlationId: input.correlationId,
    };
    if (input.error || !input.code) {
      await recordAudit(this.deps.db, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'oauth_state',
        entityId: stateRow.id,
        event: 'oauth.provider_error',
        correlationId: input.correlationId,
        data: { provider: 'x', error: input.error ?? 'missing_code' },
      });
      return {
        ok: false,
        redirectTo: stateRow.redirectTo,
        reason:
          input.error === 'access_denied'
            ? 'X authorization was cancelled.'
            : `X returned an error: ${input.errorDescription ?? input.error ?? 'no code'}`,
      };
    }
    try {
      const tokens = await this.deps.client.exchangeCode(input.code, stateRow.pkceVerifier);
      const identity = await this.deps.client.fetchIdentity(tokens.accessToken);
      await this.deps.socialAccounts.connectAccounts(ctx, [
        {
          provider: 'x',
          accountType: 'member',
          providerAccountId: identity.id,
          displayName: `@${identity.username}`,
          avatarUrl: identity.profileImageUrl ?? null,
          tokens: {
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
            refreshToken: tokens.refreshToken,
          },
          metadata: { username: identity.username, name: identity.name },
        },
      ]);
      return { ok: true, workspaceId: ctx.workspaceId, redirectTo: stateRow.redirectTo };
    } catch (err) {
      if (err instanceof ConnectionError)
        return { ok: false, redirectTo: stateRow.redirectTo, reason: err.message };
      if (err instanceof XOAuthError) {
        this.deps.logger.warn(
          { code: err.code, status: err.status, workspaceId: ctx.workspaceId },
          'x oauth failed',
        );
        return {
          ok: false,
          redirectTo: stateRow.redirectTo,
          reason: 'Could not complete the X connection. Please try again.',
        };
      }
      throw err;
    }
  }
}
