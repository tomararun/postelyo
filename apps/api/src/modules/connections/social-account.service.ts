import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { socialAccount, type SocialAccount } from '../../infra/db/schema.js';
import { withTenantScope, type TenantTx } from '../../infra/db/tenant-scope.js';
import type { Clock } from '../../shared/clock.js';
import { systemClock } from '../../shared/clock.js';
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
    public readonly code:
      'already_connected' | 'not_found' | 'no_credentials' | 'refresh_failed' | 'plan_limit',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export type SocialAccountType = 'member' | 'organization' | 'page' | 'business';
export type SocialProvider = SocialAccount['provider'];

/** Tokens as every OAuth client returns them. */
export interface AccountTokens {
  accessToken: string;
  /** Null for tokens that do not expire (Meta Page tokens). */
  expiresAt: Date | null;
  scopes: string[];
  refreshToken?: string | undefined;
  refreshTokenExpiresAt?: Date | undefined;
}

/** Refreshes an expiring access token (X); registered per provider by the composition root. */
export type TokenRefresher = (refreshToken: string) => Promise<AccountTokens>;

/** Public shape: never includes token columns (security.md §7). */
export interface SocialAccountDto {
  id: string;
  provider: SocialProvider;
  accountType: SocialAccountType;
  providerAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  status: SocialAccount['status'];
  scopes: string[];
  tokenExpiresAt: Date | null;
  parentAccountId: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

const ACCOUNT_TYPES = new Set<SocialAccountType>(['member', 'organization', 'page', 'business']);

export function accountTypeOf(a: Pick<SocialAccount, 'accountType'>): SocialAccountType {
  return ACCOUNT_TYPES.has(a.accountType as SocialAccountType)
    ? (a.accountType as SocialAccountType)
    : 'member';
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
    parentAccountId: a.parentAccountId,
    connectedAt: a.createdAt,
    disconnectedAt: a.disconnectedAt,
  };
}

export interface UpsertAccountInput {
  provider: SocialProvider;
  accountType: SocialAccountType;
  providerAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  tokens: AccountTokens;
  parentAccountId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Extra non-secret audit data. */
  data?: Record<string, unknown> | undefined;
}

/** Refresh when the token expires within this window (X tokens last 2 h). */
const REFRESH_LEAD_MS = 5 * 60_000;

/**
 * Social accounts (domain-model §2.5, architecture §6). Tokens are sealed on the
 * way in and only opened through `withAccessToken`, which audits the access and
 * refreshes expiring tokens when the provider supports it. Tenant-facing
 * methods run under the RLS tenant scope. Any number of accounts per provider
 * (Phase 2); the Notion `Platforms` option picks the target.
 */
export class SocialAccountService {
  private readonly refreshers = new Map<SocialProvider, TokenRefresher>();
  /** Plan-limit guard (Phase 3): throws when connecting `adding` accounts would exceed the plan. */
  private capacityGuard: ((workspaceId: string, adding: number) => Promise<void>) | null = null;

  constructor(
    private readonly db: Db,
    private readonly vault: CredentialVault,
    private readonly clock: Clock = systemClock,
  ) {}

  registerRefresher(provider: SocialProvider, refresher: TokenRefresher): void {
    this.refreshers.set(provider, refresher);
  }

  registerCapacityGuard(guard: (workspaceId: string, adding: number) => Promise<void>): void {
    this.capacityGuard = guard;
  }

  /** Counts only accounts that are new to the workspace (reconnects are free). */
  private async assertCapacity(
    ctx: TenantContext,
    candidates: { provider: SocialProvider; providerAccountId: string }[],
  ): Promise<void> {
    if (!this.capacityGuard) return;
    const rows = await withTenantScope(this.db, ctx.workspaceId, (tx) =>
      tx
        .select({
          provider: socialAccount.provider,
          providerAccountId: socialAccount.providerAccountId,
        })
        .from(socialAccount)
        .where(
          and(eq(socialAccount.workspaceId, ctx.workspaceId), isNull(socialAccount.disconnectedAt)),
        ),
    );
    const known = new Set(rows.map((r) => `${r.provider}:${r.providerAccountId}`));
    const adding = candidates.filter(
      (c) => !known.has(`${c.provider}:${c.providerAccountId}`),
    ).length;
    if (adding === 0) return;
    try {
      await this.capacityGuard(ctx.workspaceId, adding);
    } catch (err) {
      // Plan limits (Phase 3) read like any other connection refusal to the OAuth callbacks.
      if (err instanceof Error && err.name === 'PlanLimitError') {
        throw new ConnectionError('plan_limit', err.message);
      }
      throw err;
    }
  }

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

  /** Upserts one LinkedIn personal profile (reconnecting refreshes its token). */
  async connectLinkedIn(
    ctx: TenantContext,
    identity: LinkedInIdentity,
    tokens: LinkedInTokens,
  ): Promise<SocialAccountDto> {
    await this.assertCapacity(ctx, [{ provider: 'linkedin', providerAccountId: identity.sub }]);
    const row = await withTenantScope(this.db, ctx.workspaceId, (tx) =>
      this.upsert(tx, ctx, {
        provider: 'linkedin',
        accountType: 'member',
        providerAccountId: identity.sub,
        displayName: identity.name,
        avatarUrl: identity.picture ?? null,
        tokens,
      }),
    );
    return toSocialAccountDto(row);
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
    await this.assertCapacity(
      ctx,
      organizations.map((o) => ({ provider: 'linkedin' as const, providerAccountId: o.id })),
    );
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const out: SocialAccountDto[] = [];
      for (const org of organizations) {
        const row = await this.upsert(tx, ctx, {
          provider: 'linkedin',
          accountType: 'organization',
          providerAccountId: org.id,
          displayName: org.name,
          avatarUrl: org.logoUrl ?? null,
          tokens,
          metadata: { vanityName: org.vanityName ?? null },
          data: { authorizedBy: identity.sub },
        });
        out.push(toSocialAccountDto(row));
      }
      return out;
    });
  }

  /** Generic connect for any provider (X profile, Facebook Pages, Instagram accounts). */
  async connectAccounts(
    ctx: TenantContext,
    inputs: UpsertAccountInput[],
  ): Promise<SocialAccountDto[]> {
    await this.assertCapacity(
      ctx,
      inputs.map((i) => ({ provider: i.provider, providerAccountId: i.providerAccountId })),
    );
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const out: SocialAccountDto[] = [];
      const idsByProviderAccount = new Map<string, string>();
      for (const input of inputs) {
        // Children (Instagram) reference the parent row created earlier in the same batch.
        const parent =
          input.parentAccountId && idsByProviderAccount.has(input.parentAccountId)
            ? idsByProviderAccount.get(input.parentAccountId)!
            : input.parentAccountId;
        const row = await this.upsert(tx, ctx, { ...input, parentAccountId: parent ?? null });
        idsByProviderAccount.set(`${input.provider}:${input.providerAccountId}`, row.id);
        out.push(toSocialAccountDto(row));
      }
      return out;
    });
  }

  private async upsert(
    tx: TenantTx,
    ctx: TenantContext,
    input: UpsertAccountInput,
  ): Promise<SocialAccount> {
    const userId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    const [existing] = await tx
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.workspaceId, ctx.workspaceId),
          eq(socialAccount.provider, input.provider),
          eq(socialAccount.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);

    const id = existing?.id ?? uuidv7();
    const sealed = this.sealTokens(id, input.tokens);
    const values = {
      accountType: input.accountType,
      ...sealed,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: 'active' as const,
      disconnectedAt: null,
      connectedByUserId: userId,
      parentAccountId: input.parentAccountId ?? null,
      metadata: input.metadata ?? existing?.metadata ?? {},
      // A fresh token restarts the expiry-reminder cycle.
      reauthReminderSentAt: null,
      reauthNotifiedAt: null,
      updatedAt: this.clock.now(),
    };

    let row: SocialAccount;
    if (existing) {
      const [updated] = await tx
        .update(socialAccount)
        .set(values)
        .where(eq(socialAccount.id, existing.id))
        .returning();
      row = updated!;
    } else {
      const [inserted] = await tx
        .insert(socialAccount)
        .values({
          id,
          workspaceId: ctx.workspaceId,
          provider: input.provider,
          providerAccountId: input.providerAccountId,
          ...values,
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
        provider: input.provider,
        accountType: input.accountType,
        scopes: input.tokens.scopes,
        tokenExpiresAt: input.tokens.expiresAt?.toISOString() ?? null,
        hasRefreshToken: Boolean(input.tokens.refreshToken),
        ...(input.data ?? {}),
      },
    });
    return row;
  }

  private sealTokens(id: string, tokens: AccountTokens) {
    const ref = { entityType: 'social_account' as const, entityId: id };
    return {
      accessTokenEnc: this.vault.seal({ ...ref, column: 'access_token' }, tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken
        ? this.vault.seal({ ...ref, column: 'refresh_token' }, tokens.refreshToken)
        : null,
      credentialKeyId: this.vault.currentKeyId,
      tokenExpiresAt: tokens.expiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? null,
      scopes: tokens.scopes,
    };
  }

  /** Wipes tokens, keeps the row for audit (domain-model invariant 4). Children are disconnected too. */
  async disconnect(ctx: TenantContext, id: string): Promise<void> {
    await withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const now = this.clock.now();
      const wipe = {
        status: 'disabled' as const,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        credentialKeyId: null,
        tokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        disconnectedAt: now,
        updatedAt: now,
      };
      const [row] = await tx
        .update(socialAccount)
        .set(wipe)
        .where(
          and(
            eq(socialAccount.workspaceId, ctx.workspaceId),
            eq(socialAccount.id, id),
            isNull(socialAccount.disconnectedAt),
          ),
        )
        .returning({ id: socialAccount.id, status: socialAccount.status });
      if (!row) throw new ConnectionError('not_found', 'social account not found');
      const children = await tx
        .update(socialAccount)
        .set(wipe)
        .where(
          and(
            eq(socialAccount.workspaceId, ctx.workspaceId),
            eq(socialAccount.parentAccountId, id),
            isNull(socialAccount.disconnectedAt),
          ),
        )
        .returning({ id: socialAccount.id });
      for (const target of [row, ...children]) {
        await recordAudit(tx, {
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          entityType: 'social_account',
          entityId: target.id,
          event: 'social_account.disconnected',
          toState: 'disabled',
          correlationId: ctx.correlationId,
          ...(target.id !== id ? { data: { reason: 'parent_disconnected', parentId: id } } : {}),
        });
      }
    });
  }

  /** Active (or re-auth pending) accounts of a workspace, optionally filtered by type. */
  async listUsable(
    ctx: TenantContext,
    filter: { provider?: SocialProvider; accountType?: SocialAccountType } = {},
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

  /**
   * Runs `fn` with the decrypted access token; access is audited with `reason`.
   * An expiring token is refreshed first when the provider has a refresher and
   * a refresh token is stored (X); a failed refresh throws `refresh_failed`.
   */
  async withAccessToken<T>(
    ctx: TenantContext,
    id: string,
    reason: CredentialReason,
    fn: (accessToken: string, account: SocialAccount) => Promise<T>,
  ): Promise<T> {
    let account = await this.get(ctx, id);
    if (!account) throw new ConnectionError('not_found', 'social account not found');
    if (!account.accessTokenEnc)
      throw new ConnectionError('no_credentials', 'account has no token');
    const now = this.clock.now();
    const refresher = this.refreshers.get(account.provider);
    if (
      refresher &&
      account.refreshTokenEnc &&
      account.tokenExpiresAt &&
      account.tokenExpiresAt.getTime() < now.getTime() + REFRESH_LEAD_MS
    ) {
      account = await this.refresh(ctx, account, refresher);
    }
    return this.vault.withCredential(
      ctx,
      { entityType: 'social_account', entityId: id, column: 'access_token' },
      account.accessTokenEnc!,
      reason,
      (token) => fn(token, account),
    );
  }

  private async refresh(
    ctx: TenantContext,
    account: SocialAccount,
    refresher: TokenRefresher,
  ): Promise<SocialAccount> {
    let tokens: AccountTokens;
    try {
      tokens = await this.vault.withCredential(
        ctx,
        { entityType: 'social_account', entityId: account.id, column: 'refresh_token' },
        account.refreshTokenEnc!,
        'refresh',
        (refreshToken) => refresher(refreshToken),
      );
    } catch (err) {
      throw new ConnectionError(
        'refresh_failed',
        `Could not refresh the ${account.provider} token: ${(err as Error).message}`,
      );
    }
    // A provider that does not rotate refresh tokens keeps the old one usable.
    const merged: AccountTokens = {
      ...tokens,
      refreshToken: tokens.refreshToken ?? undefined,
    };
    return withTenantScope(this.db, ctx.workspaceId, async (tx) => {
      const sealed = this.sealTokens(account.id, merged);
      const [updated] = await tx
        .update(socialAccount)
        .set({
          ...sealed,
          ...(merged.refreshToken ? {} : { refreshTokenEnc: account.refreshTokenEnc }),
          reauthReminderSentAt: null,
          updatedAt: this.clock.now(),
        })
        .where(eq(socialAccount.id, account.id))
        .returning();
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'social_account',
        entityId: account.id,
        event: 'social_account.token_refreshed',
        correlationId: ctx.correlationId,
        data: {
          provider: account.provider,
          tokenExpiresAt: merged.expiresAt?.toISOString() ?? null,
        },
      });
      return updated!;
    });
  }
}
