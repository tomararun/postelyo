import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { Db } from '../../infra/db/client.js';
import {
  membership,
  ssoConnection,
  ssoState,
  user,
  workspace,
  type SsoConnection,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { BillingService } from '../billing/billing.service.js';
import { planHas } from '../billing/plans.js';
import type { CredentialVault } from '../connections/credential-vault.js';
import { ROLES, systemContext, type Role, type TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 7 SSO with OpenID Connect, one connection per workspace matched by
 * email domain. Authorization Code + PKCE, id_token verified against the
 * issuer's JWKS, email domain enforced, then a Better Auth session created
 * through the magic-link path so sessions stay the standard kind. First-time
 * users join the workspace with the connection's default role.
 */

export class SsoError extends Error {
  constructor(
    public readonly code: 'not_entitled' | 'not_found' | 'invalid' | 'discovery' | 'denied',
    message: string,
  ) {
    super(message);
    this.name = 'SsoError';
  }
}

export interface SsoConnectionDto {
  workspaceId: string;
  issuer: string;
  clientId: string;
  emailDomain: string;
  defaultRole: Role;
  enabled: boolean;
  updatedAt: Date;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface SsoServiceDeps {
  db: Db;
  vault: CredentialVault;
  clock: Clock;
  logger: Logger;
  appBaseUrl: string;
  billing?: BillingService;
  fetchImpl?: typeof fetch;
}

const STATE_TTL_MS = 10 * 60_000;

export class SsoService {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly deps: SsoServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  redirectUri(): string {
    return `${this.deps.appBaseUrl.replace(/\/$/, '')}/api/auth/sso/callback`;
  }

  async get(ctx: TenantContext): Promise<SsoConnectionDto | null> {
    const [row] = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(ssoConnection)
        .where(eq(ssoConnection.workspaceId, ctx.workspaceId))
        .limit(1),
    );
    return row ? toDto(row) : null;
  }

  async upsert(
    ctx: TenantContext,
    input: {
      issuer: string;
      clientId: string;
      clientSecret?: string | undefined;
      emailDomain: string;
      defaultRole?: Role | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<SsoConnectionDto> {
    await this.assertEntitled(ctx.workspaceId);
    const issuer = input.issuer.trim().replace(/\/$/, '');
    if (!/^https:\/\//.test(issuer) && !issuer.startsWith('http://localhost'))
      throw new SsoError('invalid', 'The issuer must be an https URL.');
    const emailDomain = input.emailDomain.trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(emailDomain))
      throw new SsoError('invalid', 'Enter the email domain, for example acme.com.');
    const role = input.defaultRole ?? 'viewer';
    if (!ROLES.includes(role) || role === 'owner')
      throw new SsoError('invalid', 'The default role must be admin, editor or viewer.');
    // The discovery document must be reachable before we store anything.
    await this.discover(issuer);
    const [existing] = await this.deps.db
      .select()
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, ctx.workspaceId))
      .limit(1);
    if (!existing && !input.clientSecret)
      throw new SsoError('invalid', 'A client secret is required.');
    const [taken] = await this.deps.db
      .select({ workspaceId: ssoConnection.workspaceId })
      .from(ssoConnection)
      .where(eq(ssoConnection.emailDomain, emailDomain))
      .limit(1);
    if (taken && taken.workspaceId !== ctx.workspaceId)
      throw new SsoError('invalid', 'That email domain is already claimed by another workspace.');
    const now = this.deps.clock.now();
    const secretEnc = input.clientSecret
      ? await this.deps.vault.sealFor(
          ctx.workspaceId,
          { entityType: 'sso_connection', entityId: ctx.workspaceId, column: 'client_secret' },
          input.clientSecret.trim(),
        )
      : existing!.clientSecretEnc;
    const values = {
      issuer,
      clientId: input.clientId.trim(),
      clientSecretEnc: secretEnc,
      emailDomain,
      defaultRole: role,
      enabled: input.enabled ?? true,
      updatedAt: now,
    };
    const [row] = await this.deps.db
      .insert(ssoConnection)
      .values({ workspaceId: ctx.workspaceId, ...values })
      .onConflictDoUpdate({ target: ssoConnection.workspaceId, set: values })
      .returning();
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'sso_connection',
      entityId: ctx.workspaceId,
      event: 'sso.connection_updated',
      correlationId: ctx.correlationId,
      data: { issuer, emailDomain, defaultRole: role, enabled: values.enabled },
    });
    return toDto(row!);
  }

  async remove(ctx: TenantContext): Promise<void> {
    await this.deps.db.delete(ssoConnection).where(eq(ssoConnection.workspaceId, ctx.workspaceId));
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'sso_connection',
      entityId: ctx.workspaceId,
      event: 'sso.connection_updated',
      correlationId: ctx.correlationId,
      data: { removed: true },
    });
  }

  /** Connection for an email address, when its domain has enabled SSO. */
  async connectionForEmail(email: string): Promise<SsoConnection | null> {
    const domain = email.trim().toLowerCase().split('@')[1] ?? '';
    if (!domain) return null;
    const [row] = await this.deps.db
      .select()
      .from(ssoConnection)
      .where(and(eq(ssoConnection.emailDomain, domain), eq(ssoConnection.enabled, true)))
      .limit(1);
    return row ?? null;
  }

  /** Builds the authorization redirect for `email`'s domain. */
  async start(email: string, redirectTo: string): Promise<{ url: string; stateId: string }> {
    const conn = await this.connectionForEmail(email);
    if (!conn)
      throw new SsoError('not_found', 'No single sign-on is configured for this email domain.');
    if (this.deps.billing && !planHas(await this.deps.billing.planFor(conn.workspaceId), 'sso'))
      throw new SsoError('not_entitled', 'Single sign-on is not available on this plan.');
    const disc = await this.discover(conn.issuer);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const id = uuidv7();
    const now = this.deps.clock.now();
    await this.deps.db.insert(ssoState).values({
      id,
      workspaceId: conn.workspaceId,
      pkceVerifier: verifier,
      nonce,
      redirectTo: safePath(redirectTo),
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      createdAt: now,
    });
    const u = new URL(disc.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', conn.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri());
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', id);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('login_hint', email.trim());
    return { url: u.toString(), stateId: id };
  }

  /**
   * Exchanges the code, verifies the id_token, checks the email domain, and
   * returns the identity plus where to send the browser next. Session creation
   * is the caller's job (through the magic-link capture).
   */
  async callback(
    stateId: string,
    code: string,
    correlationId: string,
  ): Promise<{
    email: string;
    name: string;
    workspaceId: string;
    redirectTo: string;
    stateId: string;
  }> {
    const now = this.deps.clock.now();
    const [st] = await this.deps.db
      .update(ssoState)
      .set({ consumedAt: now })
      .where(and(eq(ssoState.id, stateId), isNull(ssoState.consumedAt)))
      .returning();
    if (!st || st.expiresAt.getTime() < now.getTime())
      throw new SsoError(
        'invalid',
        'The sign-in request expired or was already used. Start again.',
      );
    const [conn] = await this.deps.db
      .select()
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, st.workspaceId))
      .limit(1);
    if (!conn || !conn.enabled) throw new SsoError('not_found', 'Single sign-on is not enabled.');
    const disc = await this.discover(conn.issuer);
    const ctx = systemContext(conn.workspaceId, 'sso', correlationId);
    const tokenRes = await this.deps.vault.withCredential(
      ctx,
      { entityType: 'sso_connection', entityId: conn.workspaceId, column: 'client_secret' },
      conn.clientSecretEnc,
      'publish',
      async (secret) =>
        this.fetchImpl(disc.token_endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri(),
            client_id: conn.clientId,
            client_secret: secret,
            code_verifier: st.pkceVerifier,
          }).toString(),
          signal: AbortSignal.timeout(10_000),
        }),
    );
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      id_token?: string;
      error?: string;
    };
    if (!tokenRes.ok || !tokenJson.id_token)
      throw new SsoError(
        'denied',
        `The identity provider rejected the code${tokenJson.error ? ` (${tokenJson.error})` : ''}.`,
      );
    const jwks = createRemoteJWKSet(new URL(disc.jwks_uri), {
      [customFetch]: this.fetchImpl,
    });
    let claims: { email?: unknown; name?: unknown; nonce?: unknown; email_verified?: unknown };
    try {
      const verified = await jwtVerify(tokenJson.id_token, jwks, {
        issuer: conn.issuer,
        audience: conn.clientId,
        clockTolerance: 60,
      });
      claims = verified.payload as typeof claims;
    } catch (err) {
      throw new SsoError('denied', `The id token could not be verified: ${(err as Error).message}`);
    }
    if (claims.nonce !== st.nonce) throw new SsoError('denied', 'Nonce mismatch.');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email)
      throw new SsoError('denied', 'The identity provider did not return an email address.');
    if (email.split('@')[1] !== conn.emailDomain)
      throw new SsoError(
        'denied',
        `Only ${conn.emailDomain} accounts may sign in through this connection.`,
      );
    return {
      email,
      name:
        typeof claims.name === 'string' && claims.name.trim()
          ? claims.name.trim()
          : email.split('@')[0]!,
      workspaceId: conn.workspaceId,
      redirectTo: st.redirectTo,
      stateId: st.id,
    };
  }

  /** After the session exists: membership with the default role (first time), audit. */
  async complete(
    stateId: string,
    userId: string,
    correlationId: string,
  ): Promise<{ workspaceId: string; redirectTo: string }> {
    const [st] = await this.deps.db
      .select()
      .from(ssoState)
      .where(eq(ssoState.id, stateId))
      .limit(1);
    if (!st) throw new SsoError('invalid', 'Unknown sign-in request.');
    const [conn] = await this.deps.db
      .select()
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, st.workspaceId))
      .limit(1);
    if (!conn) throw new SsoError('not_found', 'Single sign-on is not enabled.');
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, st.workspaceId))
      .limit(1);
    if (!ws || ws.deletedAt) throw new SsoError('not_found', 'The workspace is gone.');
    const [u] = await this.deps.db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!u || (u.email.split('@')[1] ?? '') !== conn.emailDomain)
      throw new SsoError('denied', 'The signed-in account does not belong to this connection.');
    const now = this.deps.clock.now();
    const inserted = await this.deps.db
      .insert(membership)
      .values({ id: uuidv7(), workspaceId: st.workspaceId, userId, role: conn.defaultRole })
      .onConflictDoNothing()
      .returning({ id: membership.id });
    await recordAudit(this.deps.db, {
      workspaceId: st.workspaceId,
      actor: { type: 'user', id: userId, role: conn.defaultRole },
      entityType: 'user',
      entityId: userId,
      event: 'sso.signed_in',
      correlationId,
      data: { issuer: conn.issuer, joined: inserted.length > 0, at: now.toISOString() },
    });
    if (inserted.length > 0) {
      await recordAudit(this.deps.db, {
        workspaceId: st.workspaceId,
        actor: { type: 'system', id: 'sso' },
        entityType: 'membership',
        entityId: inserted[0]!.id,
        event: 'membership.created',
        correlationId,
        data: { userId, role: conn.defaultRole, via: 'sso' },
      });
    }
    return { workspaceId: st.workspaceId, redirectTo: st.redirectTo };
  }

  private async discover(issuer: string): Promise<Discovery> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new SsoError(
        'discovery',
        `Could not reach the identity provider: ${(err as Error).message}`,
      );
    }
    if (!res.ok)
      throw new SsoError(
        'discovery',
        `The identity provider's discovery document returned ${res.status}.`,
      );
    const json = (await res.json().catch(() => ({}))) as Partial<Discovery> & { issuer?: string };
    if (!json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri)
      throw new SsoError('discovery', 'The discovery document is missing required endpoints.');
    if (json.issuer && json.issuer.replace(/\/$/, '') !== issuer)
      throw new SsoError('discovery', 'The discovery document names a different issuer.');
    return json as Discovery;
  }

  private async assertEntitled(workspaceId: string): Promise<void> {
    if (!this.deps.billing) return;
    if (!planHas(await this.deps.billing.planFor(workspaceId), 'sso'))
      throw new SsoError('not_entitled', 'Single sign-on needs the Enterprise plan.');
  }
}

function safePath(p: string): string {
  return p.startsWith('/') && !p.startsWith('//') ? p : '/';
}

function toDto(c: SsoConnection): SsoConnectionDto {
  return {
    workspaceId: c.workspaceId,
    issuer: c.issuer,
    clientId: c.clientId,
    emailDomain: c.emailDomain,
    defaultRole: c.defaultRole,
    enabled: c.enabled,
    updatedAt: c.updatedAt,
  };
}
