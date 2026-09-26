import type { Db } from '../../../infra/db/client.js';
import type { Logger } from '../../../infra/logger.js';
import { recordAudit } from '../../audit/audit.js';
import type { ContentSourceService } from '../../content-sources/content-source.service.js';
import type { TenantContext } from '../../tenancy/tenant-context.js';
import type { OAuthStateService } from '../oauth-state.service.js';
import { ConnectionError } from '../social-account.service.js';
import { NotionOAuthError, type NotionOAuthClient } from './notion-oauth.js';

export interface NotionConnectDeps {
  db: Db;
  logger: Logger;
  client: NotionOAuthClient;
  contentSources: ContentSourceService;
  states: OAuthStateService;
  /** Where to send the admin after the callback: the setup wizard for that source. */
  setupPath: (workspaceId: string, sourceId: string) => string;
  returnPath: (workspaceId: string) => string;
}

export type NotionCallbackOutcome =
  | { ok: true; workspaceId: string; redirectTo: string; sourceId: string }
  | { ok: false; redirectTo: string; reason: string };

/**
 * "Connect with Notion" (Phase 3, public integration). The callback stores the
 * bot token as a pending content source; the setup wizard then creates the
 * template database in a chosen page or adopts an existing database.
 */
export class NotionConnectFlow {
  constructor(private readonly deps: NotionConnectDeps) {}

  async start(ctx: TenantContext, userId: string): Promise<string> {
    const state = await this.deps.states.create({
      workspaceId: ctx.workspaceId,
      userId,
      provider: 'notion',
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
  }): Promise<NotionCallbackOutcome> {
    const stateRow = input.state
      ? await this.deps.states.consume(input.state, input.userId, 'notion')
      : null;
    if (!stateRow) {
      await recordAudit(this.deps.db, {
        workspaceId: null,
        actor: { type: 'user', id: input.userId, role: 'viewer' },
        entityType: 'oauth_state',
        entityId: input.state ?? 'missing',
        event: 'oauth.state_mismatch',
        correlationId: input.correlationId,
        data: { provider: 'notion' },
      });
      return {
        ok: false,
        redirectTo: '/',
        reason: 'The Notion link was invalid or expired. Please try again.',
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
        data: { provider: 'notion', error: input.error ?? 'missing_code' },
      });
      return {
        ok: false,
        redirectTo: stateRow.redirectTo,
        reason:
          input.error === 'access_denied'
            ? 'Notion authorization was cancelled.'
            : `Notion returned an error: ${input.error ?? 'no code'}`,
      };
    }
    try {
      const tokens = await this.deps.client.exchangeCode(input.code);
      const source = await this.deps.contentSources.connectNotionOAuth(ctx, tokens);
      return {
        ok: true,
        workspaceId: ctx.workspaceId,
        sourceId: source.id,
        redirectTo: this.deps.setupPath(ctx.workspaceId, source.id),
      };
    } catch (err) {
      if (err instanceof ConnectionError)
        return { ok: false, redirectTo: stateRow.redirectTo, reason: err.message };
      if (err instanceof NotionOAuthError) {
        this.deps.logger.warn(
          { code: err.code, status: err.status, workspaceId: ctx.workspaceId },
          'notion oauth failed',
        );
        return {
          ok: false,
          redirectTo: stateRow.redirectTo,
          reason: 'Could not complete the Notion connection. Please try again.',
        };
      }
      throw err;
    }
  }
}
