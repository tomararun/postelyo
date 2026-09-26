import type { Db } from '../../../infra/db/client.js';
import type { Logger } from '../../../infra/logger.js';
import { recordAudit } from '../../audit/audit.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { OAuthAccountType, OAuthStateService } from '../oauth-state.service.js';
import { ConnectionError, type SocialAccountService } from '../social-account.service.js';
import { type LinkedInOAuthClient, LinkedInOAuthError } from './linkedin-oauth.js';

export interface LinkedInConnectDeps {
  db: Db;
  logger: Logger;
  client: LinkedInOAuthClient;
  socialAccounts: SocialAccountService;
  states: OAuthStateService;
  /** Builds the same-origin page to return to after the callback. */
  returnPath: (workspaceId: string) => string;
}

export type CallbackOutcome =
  | { ok: true; workspaceId: string; redirectTo: string; accountType: OAuthAccountType }
  | { ok: false; redirectTo: string; reason: string };

/**
 * Orchestrates the LinkedIn OAuth flow (architecture §6.2). The api process
 * only performs the code exchange; publishing happens in the worker.
 *
 * Two flavours share the flow: `member` connects the personal profile,
 * `organization` connects every LinkedIn Page the member administers (each as
 * its own social account; unwanted pages are disconnected on the Connections page).
 */
export class LinkedInConnectFlow {
  constructor(private readonly deps: LinkedInConnectDeps) {}

  /** Creates a bound state and returns the provider authorization URL. */
  async start(
    ctx: TenantContext,
    userId: string,
    accountType: OAuthAccountType = 'member',
  ): Promise<string> {
    const state = await this.deps.states.create({
      workspaceId: ctx.workspaceId,
      userId,
      provider: 'linkedin',
      accountType,
      redirectTo: this.deps.returnPath(ctx.workspaceId),
    });
    return this.deps.client.authorizationUrl(state, accountType);
  }

  /**
   * Handles the provider redirect. Never throws for user-facing failures; the
   * caller redirects to `redirectTo` with a message. Unknown/foreign states go
   * back to the home page because no workspace can be trusted.
   */
  async callback(input: {
    userId: string;
    correlationId: string;
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
  }): Promise<CallbackOutcome> {
    const stateRow = input.state
      ? await this.deps.states.consume(input.state, input.userId, 'linkedin')
      : null;
    if (!stateRow) {
      await recordAudit(this.deps.db, {
        workspaceId: null,
        actor: { type: 'user', id: input.userId, role: 'viewer' },
        entityType: 'oauth_state',
        entityId: input.state ?? 'missing',
        event: 'oauth.state_mismatch',
        correlationId: input.correlationId,
        data: { provider: 'linkedin' },
      });
      return {
        ok: false,
        redirectTo: '/',
        reason: 'The LinkedIn sign-in link was invalid or expired. Please try again.',
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
        data: {
          provider: 'linkedin',
          accountType: stateRow.accountType,
          error: input.error ?? 'missing_code',
        },
      });
      const denied =
        input.error === 'user_cancelled_authorize' || input.error === 'user_cancelled_login';
      return {
        ok: false,
        redirectTo: stateRow.redirectTo,
        reason: denied
          ? 'LinkedIn authorization was cancelled.'
          : `LinkedIn returned an error: ${input.errorDescription ?? input.error ?? 'no code'}`,
      };
    }

    try {
      const tokens = await this.deps.client.exchangeCode(input.code);
      const identity = await this.deps.client.fetchIdentity(tokens.accessToken);
      if (stateRow.accountType === 'organization') {
        const orgs = await this.deps.client.fetchAdministeredOrganizations(tokens.accessToken);
        if (orgs.length === 0) {
          return {
            ok: false,
            redirectTo: stateRow.redirectTo,
            reason:
              'LinkedIn reports no Pages that you administer. Ask a Page super admin to add you, then try again.',
          };
        }
        await this.deps.socialAccounts.connectLinkedInOrganizations(ctx, identity, tokens, orgs);
      } else {
        await this.deps.socialAccounts.connectLinkedIn(ctx, identity, tokens);
      }
      return {
        ok: true,
        workspaceId: ctx.workspaceId,
        redirectTo: stateRow.redirectTo,
        accountType: stateRow.accountType,
      };
    } catch (err) {
      if (err instanceof ConnectionError) {
        return { ok: false, redirectTo: stateRow.redirectTo, reason: err.message };
      }
      if (err instanceof LinkedInOAuthError) {
        this.deps.logger.warn(
          { code: err.code, status: err.status, workspaceId: ctx.workspaceId },
          'linkedin oauth failed',
        );
        return {
          ok: false,
          redirectTo: stateRow.redirectTo,
          reason:
            err.code === 'organizations_failed'
              ? 'LinkedIn did not allow listing your Pages. The app may lack Community Management API access; connect the profile instead or contact support.'
              : 'Could not complete the LinkedIn connection. Please try again.',
        };
      }
      throw err;
    }
  }
}
