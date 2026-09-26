import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { socialAccount, type SocialAccount } from '../../infra/db/schema.js';
import { withTenantScope, type TenantTx } from '../../infra/db/tenant-scope.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { CredentialReason, CredentialVault } from './credential-vault.js';
import type {
  LinkedInIdentity,
  LinkedInOrganization,
  LinkedInTokens,
} from './linkedin/linkedin-oauth.js';

export class ConnectionError extends Error {
  constructor(
    public readonly code: 'already_connected' | 'not_found' | 'no_credentials',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export type SocialAccountType = 'member' | 'organization';

/** Public shape: never includes token columns (security.md §7). */
export interface SocialAccountDto {
  id: string;
  provider: SocialAccount['provider'];
  accountType: SocialAccountType;
  providerAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  status: SocialAccount['status'];
  scopes: string[];
  tokenExpiresAt: Date | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

export function accountTypeOf(a: Pick<SocialAccount, 'accountType'>): SocialAccountType {
  return a.accountType === 'organization' ? 'organization' : 'member';
}

export function toSocialAccountDto(a: SocialAccount): SocialAccountDto {
  return {
    id: a.id,
    provider: a.provider,
    accountType: accountTypeOf(a),
    providerAccountId: a.providerAccountId,
    displayName: a.displayName,
    avatarUrl: a.avatarUrl,
    status: a.status,
    scopes: a.scopes,
    tokenExpiresAt: a.tokenExpiresAt,
    connectedAt: a.createdAt,
    disconnectedAt: a.disconnectedAt,
  };
}

/**
 * Social accounts (domain-model §2.5, architecture §6). Tokens are sealed on the
 * way in and only opened through `withAccessToken`, which audits the access.
 * Tenant-facing methods run under the RLS tenant scope.
 */
export class SocialAccountService {
  constructor(
    private readonly db: Db,
    private readonly vault: CredentialVault,
  ) {}

  async list(ctx: TenantContext): Promise<SocialAccountDto[]> {
    const rows = await withTenantScope(this.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(socialAccount)
        .where(eq(socialAccount.workspaceId, ctx.workspaceId))
        .orderBy(socialAccount.createdAt),
    );
    return rows.map(toSocialAccountDto);
  }

  async get(ctx: TenantContext, id: string): Promise<SocialAccount | null> {
    const [row] = await withTenantScope(this.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(socialAccount)
        .where(and(eq(socialAccount.workspaceId, ctx.workspaceId), eq(socialAccount.id, id)))
        .limit(1),
    );
    return row ?? null;
  }

  /**
   * Upserts the LinkedIn personal profile for this workspace. Rule (P1): one
   * connected LinkedIn profile per workspace; reconnecting the same profile
   * refreshes tokens, a different profile is rejected until disconnect.
   */
  async connectLinkedIn(
    ctx: TenantContext,
    identity: LinkedInIdentity,
    tokens: LinkedInTokens,
  ): Promise<SocialAccountDto> {
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const existing = await tx
        .select()
        .from(socialAccount)
        .where(
          and(
            eq(socialAccount.workspaceId, ctx.workspaceId),
            eq(socialAccount.provider, 'linkedin'),
            eq(socialAccount.accountType, 'member'),
            isNull(socialAccount.disconnectedAt),
          ),
        );
      const other = existing.find((a) => a.providerAccountId !== identity.sub);
      if (other) {
        throw new ConnectionError(
          'already_connected',
          `A different LinkedIn profile (${other.displayName}) is already connected. Disconnect it first.`,
        );
      }
      const row = await this.upsert(tx, ctx, {
        accountType: 'member',
        providerAccountId: identity.sub,
        displayName: identity.name,
        avatarUrl: identity.picture ?? null,
        tokens,
      });
      return toSocialAccountDto(row);
    });
  }

  /**
   * Connects every LinkedIn Page the member administers as its own account
   * (Phase 1). Pages already connected are refreshed; the admin removes
   * unwanted ones with Disconnect. The member's own token is what LinkedIn
   * uses for organization posts, so each row carries the same sealed token.
   */
  async connectLinkedInOrganizations(
    ctx: TenantContext,
    identity: LinkedInIdentity,
    tokens: LinkedInTokens,
    organizations: LinkedInOrganization[],
  ): Promise<SocialAccountDto[]> {
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const out: SocialAccountDto[] = [];
      for (const org of organizations) {
        const row = await this.upsert(tx, ctx, {
          accountType: 'organization',
          providerAccountId: org.id,
          displayName: org.name,
          avatarUrl: org.logoUrl ?? null,
          tokens,
          data: { authorizedBy: identity.sub, vanityName: org.vanityName ?? null },
        });
        out.push(toSocialAccountDto(row));
      }
      return out;
    });
  }

  private async upsert(
    tx: TenantTx,
    ctx: TenantContext,
    input: {
      accountType: SocialAccountType;
      providerAccountId: string;
      displayName: string;
      avatarUrl: string | null;
      tokens: LinkedInTokens;
      data?: Record<string, unknown>;
    },
  ): Promise<SocialAccount> {
    const userId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    const [existing] = await tx
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.workspaceId, ctx.workspaceId),
          eq(socialAccount.provider, 'linkedin'),
          eq(socialAccount.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);

    const id = existing?.id ?? uuidv7();
    const ref = { entityType: 'social_account' as const, entityId: id };
    const { tokens } = input;
    const sealed = {
      accountType: input.accountType,
      accessTokenEnc: this.vault.seal({ ...ref, column: 'access_token' }, tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken
        ? this.vault.seal({ ...ref, column: 'refresh_token' }, tokens.refreshToken)
        : null,
      credentialKeyId: this.vault.currentKeyId,
      tokenExpiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
      scopes: tokens.scopes,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: 'active' as const,
      disconnectedAt: null,
      connectedByUserId: userId,
      // A fresh token restarts the expiry-reminder cycle.
      reauthReminderSentAt: null,
      reauthNotifiedAt: null,
      updatedAt: new Date(),
    };

    let row: SocialAccount;
    if (existing) {
      const [updated] = await tx
        .update(socialAccount)
        .set(sealed)
        .where(eq(socialAccount.id, existing.id))
        .returning();
      row = updated!;
    } else {
      const [inserted] = await tx
        .insert(socialAccount)
        .values({
          id,
          workspaceId: ctx.workspaceId,
          provider: 'linkedin',
          providerAccountId: input.providerAccountId,
          ...sealed,
        })
        .returning();
      row = inserted!;
    }

    await recordAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'social_account',
      entityId: row.id,
      event: existing ? 'social_account.reconnected' : 'social_account.connected',
      fromState: existing?.status ?? null,
      toState: 'active',
      correlationId: ctx.correlationId,
      data: {
        provider: 'linkedin',
        accountType: input.accountType,
        scopes: tokens.scopes,
        tokenExpiresAt: tokens.expiresAt.toISOString(),
        hasRefreshToken: Boolean(tokens.refreshToken),
        ...(input.data ?? {}),
      },
    });
    return row;
  }

  /** Wipes tokens, keeps the row for audit (domain-model invariant 4). */
  async disconnect(ctx: TenantContext, id: string): Promise<void> {
    await withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .update(socialAccount)
        .set({
          status: 'disabled',
          accessTokenEnc: null,
          refreshTokenEnc: null,
          credentialKeyId: null,
          tokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          disconnectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(socialAccount.workspaceId, ctx.workspaceId),
            eq(socialAccount.id, id),
            isNull(socialAccount.disconnectedAt),
          ),
        )
        .returning({ id: socialAccount.id, status: socialAccount.status });
      if (!row) throw new ConnectionError('not_found', 'social account not found');
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'social_account',
        entityId: id,
        event: 'social_account.disconnected',
        toState: 'disabled',
        correlationId: ctx.correlationId,
      });
    });
  }

  /** Active (or re-auth pending) accounts of a workspace, optionally filtered by type. */
  async listUsable(
    ctx: TenantContext,
    filter: { provider?: SocialAccount['provider']; accountType?: SocialAccountType } = {},
  ): Promise<SocialAccount[]> {
    const conditions = [
      eq(socialAccount.workspaceId, ctx.workspaceId),
      isNull(socialAccount.disconnectedAt),
      inArray(socialAccount.status, ['active', 'needs_reauth']),
    ];
    if (filter.provider) conditions.push(eq(socialAccount.provider, filter.provider));
    if (filter.accountType) conditions.push(eq(socialAccount.accountType, filter.accountType));
    return withTenantScope(this.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(socialAccount)
        .where(and(...conditions))
        .orderBy(socialAccount.createdAt),
    );
  }

  /** Runs `fn` with the decrypted access token; access is audited with `reason`. */
  async withAccessToken<T>(
    ctx: TenantContext,
    id: string,
    reason: CredentialReason,
    fn: (accessToken: string, account: SocialAccount) => Promise<T>,
  ): Promise<T> {
    const account = await this.get(ctx, id);
    if (!account) throw new ConnectionError('not_found', 'social account not found');
    if (!account.accessTokenEnc)
      throw new ConnectionError('no_credentials', 'account has no token');
    return this.vault.withCredential(
      ctx,
      { entityType: 'social_account', entityId: id, column: 'access_token' },
      account.accessTokenEnc,
      reason,
      (token) => fn(token, account),
    );
  }
}
