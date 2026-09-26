import type { Db } from '../../../infra/db/client.js';
import type { Logger } from '../../../infra/logger.js';
import { recordAudit } from '../../audit/audit.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { OAuthStateService } from '../oauth-state.service.js';
import {
  ConnectionError,
  type SocialAccountService,
  type UpsertAccountInput,
} from '../social-account.service.js';
import { MetaOAuthError, type MetaOAuthClient } from './meta-oauth.js';

export interface MetaConnectDeps {
  db: Db;
  logger: Logger;
  client: MetaOAuthClient;
  socialAccounts: SocialAccountService;
  states: OAuthStateService;
  returnPath: (workspaceId: string) => string;
}

export type MetaCallbackOutcome =
  | { ok: true; workspaceId: string; redirectTo: string; pages: number; instagram: number }
  | { ok: false; redirectTo: string; reason: string };

/**
 * Facebook Login connect flow (Phase 2): every managed Page becomes a
 * `facebook`/`page` account with its Page token; a linked Instagram
 * professional account becomes an `instagram`/`business` account that hangs
 * off the Page and shares its token. Unwanted accounts are disconnected on the
 * Connections page. Page tokens derived from a long-lived user token do not expire.
 */
export class MetaConnectFlow {
  constructor(private readonly deps: MetaConnectDeps) {}

  async start(ctx: TenantContext, userId: string): Promise<string> {
    const state = await this.deps.states.create({
      workspaceId: ctx.workspaceId,
      userId,
      provider: 'facebook',
      accountType: 'organization',
      redirectTo: this.deps.returnPath(ctx.workspaceId),
    });
    return this.deps.client.authorizationUrl(state);
  }

  async callback(input: {
    userId: string;
    correlationId: string;
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
    errorDescription?: string | undefined;
  }): Promise<MetaCallbackOutcome> {
    const stateRow = input.state
      ? await this.deps.states.consume(input.state, input.userId, 'facebook')
      : null;
    if (!stateRow) {
      await recordAudit(this.deps.db, {
        workspaceId: null,
        actor: { type: 'user', id: input.userId, role: 'viewer' },
        entityType: 'oauth_state',
        entityId: input.state ?? 'missing',
        event: 'oauth.state_mismatch',
        correlationId: input.correlationId,
        data: { provider: 'facebook' },
      });
      return {
        ok: false,
        redirectTo: '/',
        reason: 'The Facebook sign-in link was invalid or expired. Please try again.',
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
        data: { provider: 'facebook', error: input.error ?? 'missing_code' },
      });
      return {
        ok: false,
        redirectTo: stateRow.redirectTo,
        reason:
          input.error === 'access_denied'
            ? 'Facebook authorization was cancelled.'
            : `Facebook returned an error: ${input.errorDescription ?? input.error ?? 'no code'}`,
      };
    }
    try {
      const user = await this.deps.client.exchangeCode(input.code);
      const pages = await this.deps.client.fetchPages(user.accessToken);
      if (pages.length === 0) {
        return {
          ok: false,
          redirectTo: stateRow.redirectTo,
          reason:
            'Facebook reports no Pages you manage. Ask a Page admin to add you, then try again.',
        };
      }
      const inputs: UpsertAccountInput[] = [];
      for (const page of pages) {
        inputs.push({
          provider: 'facebook',
          accountType: 'page',
          providerAccountId: page.id,
          displayName: page.name,
          avatarUrl: page.pictureUrl ?? null,
          tokens: {
            accessToken: page.accessToken,
            expiresAt: null,
            scopes: ['pages_manage_posts'],
          },
          metadata: { userTokenExpiresAt: user.expiresAt?.toISOString() ?? null },
        });
        if (page.instagram) {
          inputs.push({
            provider: 'instagram',
            accountType: 'business',
            providerAccountId: page.instagram.id,
            displayName: `@${page.instagram.username}`,
            avatarUrl: page.instagram.pictureUrl ?? null,
            tokens: {
              accessToken: page.accessToken,
              expiresAt: null,
              scopes: ['instagram_content_publish'],
            },
            parentAccountId: `facebook:${page.id}`,
            metadata: { username: page.instagram.username, pageId: page.id },
          });
        }
      }
      await this.deps.socialAccounts.connectAccounts(ctx, inputs);
      return {
        ok: true,
        workspaceId: ctx.workspaceId,
        redirectTo: stateRow.redirectTo,
        pages: pages.length,
        instagram: pages.filter((p) => p.instagram).length,
      };
    } catch (err) {
      if (err instanceof ConnectionError)
        return { ok: false, redirectTo: stateRow.redirectTo, reason: err.message };
      if (err instanceof MetaOAuthError) {
        this.deps.logger.warn(
          { code: err.code, status: err.status, workspaceId: ctx.workspaceId },
          'meta oauth failed',
        );
        return {
          ok: false,
          redirectTo: stateRow.redirectTo,
          reason:
            err.code === 'pages_failed'
              ? 'Facebook did not allow listing your Pages. The app may still be awaiting Meta review.'
              : 'Could not complete the Facebook connection. Please try again.',
        };
      }
      throw err;
    }
  }
}
