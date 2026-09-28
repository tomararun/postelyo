import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  contentSource,
  socialAccount,
  ssoConnection,
  webhookEndpoint,
  workspaceKey,
  type WorkspaceKey,
} from '../../infra/db/schema.js';
import {
  unwrapDek,
  wrapDek,
  type KeyProvider,
  KeyProviderError,
} from '../../infra/crypto/key-provider.js';
import { envelopeKeyId } from '../../infra/crypto/envelope.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { planHas } from '../billing/plans.js';
import type { BillingService } from '../billing/billing.service.js';
import type { CredentialVault } from '../connections/credential-vault.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 7 per-tenant data keys. An enterprise workspace gets its own random
 * 32-byte key, itself wrapped by the master key (`workspace_key`). Every
 * credential of that workspace is sealed under the tenant key (envelope key
 * ids `t<version>`); rotation mints a new version and re-seals everything.
 * Workspaces without a key keep using the master key, so nothing changes for
 * existing plans.
 */

export class TenantKeyError extends Error {
  constructor(
    public readonly code: 'not_entitled' | 'already_enabled' | 'not_enabled',
    message: string,
  ) {
    super(message);
    this.name = 'TenantKeyError';
  }
}

export interface TenantKeyStatus {
  enabled: boolean;
  version: number | null;
  createdAt: Date | null;
  rotatedAt: Date | null;
  /** Credentials in the workspace and how many are sealed under the current tenant key. */
  credentials: { total: number; onCurrentKey: number };
}

/** KeyProvider view of one workspace: wraps under the tenant key, unwraps tenant or master ids. */
class TenantKeyProvider implements KeyProvider {
  readonly currentKeyId: string;
  constructor(
    private readonly version: number,
    private readonly raw: Buffer,
    private readonly master: KeyProvider,
  ) {
    this.currentKeyId = `t${version}`;
  }
  wrap(dek: Buffer): { keyId: string; wrapped: Buffer } {
    return { keyId: this.currentKeyId, wrapped: wrapDek(this.raw, this.currentKeyId, dek) };
  }
  unwrap(keyId: string, wrapped: Buffer): Buffer {
    if (keyId === this.currentKeyId) return unwrapDek(this.raw, keyId, wrapped);
    if (keyId.startsWith('t'))
      throw new KeyProviderError(`tenant key ${keyId} is not current (v${this.version})`);
    return this.master.unwrap(keyId, wrapped);
  }
}

export interface TenantKeyServiceDeps {
  db: Db;
  master: KeyProvider;
  clock: Clock;
  /** Set after construction (the vault needs this service, this service needs the vault). */
  vault?: CredentialVault;
  billing?: BillingService;
}

export class TenantKeyService {
  private vault: CredentialVault | null;
  private billing: BillingService | null;
  constructor(private readonly deps: TenantKeyServiceDeps) {
    this.vault = deps.vault ?? null;
    this.billing = deps.billing ?? null;
  }

  attach(vault: CredentialVault): void {
    this.vault = vault;
  }

  setBilling(billing: BillingService): void {
    this.billing = billing;
  }

  /** Master key when the workspace has no tenant key. */
  async providerFor(workspaceId: string): Promise<KeyProvider> {
    const row = await this.load(workspaceId);
    if (!row) return this.deps.master;
    return new TenantKeyProvider(
      row.version,
      this.deps.master.unwrap(row.masterKeyId, row.wrappedKey),
      this.deps.master,
    );
  }

  async status(ctx: TenantContext): Promise<TenantKeyStatus> {
    const row = await this.load(ctx.workspaceId);
    const blobs = await this.credentialBlobs(ctx.workspaceId);
    const current = row ? `t${row.version}` : null;
    return {
      enabled: row !== null,
      version: row?.version ?? null,
      createdAt: row?.createdAt ?? null,
      rotatedAt: row?.rotatedAt ?? null,
      credentials: {
        total: blobs.length,
        onCurrentKey: current ? blobs.filter((b) => envelopeKeyId(b.blob) === current).length : 0,
      },
    };
  }

  /** Mints version 1 and re-seals every credential of the workspace under it. */
  async enable(ctx: TenantContext): Promise<TenantKeyStatus> {
    await this.assertEntitled(ctx.workspaceId);
    if (await this.load(ctx.workspaceId))
      throw new TenantKeyError('already_enabled', 'Per-tenant keys are already enabled.');
    await this.mint(ctx.workspaceId, 1, null);
    await this.resealAll(ctx.workspaceId);
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      event: 'workspace_key.enabled',
      correlationId: ctx.correlationId,
      data: { version: 1 },
    });
    return this.status(ctx);
  }

  /** New version, everything re-sealed; the old key is gone once this returns. */
  async rotate(ctx: TenantContext): Promise<TenantKeyStatus> {
    await this.assertEntitled(ctx.workspaceId);
    const row = await this.load(ctx.workspaceId);
    if (!row) throw new TenantKeyError('not_enabled', 'Per-tenant keys are not enabled.');
    // Decrypt everything with the old key first (into memory as blobs re-sealed under the new key).
    const oldProvider = await this.providerFor(ctx.workspaceId);
    const next = row.version + 1;
    const raw = randomBytes(32);
    const nextProvider = new TenantKeyProvider(next, raw, this.deps.master);
    const resealed = await this.resealWith(ctx.workspaceId, oldProvider, nextProvider);
    await this.mint(ctx.workspaceId, next, raw);
    await this.writeBlobs(resealed, `t${next}`);
    raw.fill(0);
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'workspace',
      entityId: ctx.workspaceId,
      event: 'workspace_key.rotated',
      correlationId: ctx.correlationId,
      data: { from: row.version, to: next, credentials: resealed.length },
    });
    return this.status(ctx);
  }

  private async assertEntitled(workspaceId: string): Promise<void> {
    if (!this.billing) return;
    const plan = await this.billing.planFor(workspaceId);
    if (!planHas(plan, 'tenantKeys'))
      throw new TenantKeyError('not_entitled', 'Per-tenant keys need the Enterprise plan.');
  }

  private async load(workspaceId: string): Promise<WorkspaceKey | null> {
    const [row] = await this.deps.db
      .select()
      .from(workspaceKey)
      .where(eq(workspaceKey.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  }

  private async mint(workspaceId: string, version: number, raw: Buffer | null): Promise<void> {
    const key = raw ?? randomBytes(32);
    // The master provider wraps 32-byte data keys; a tenant key is exactly that,
    // so a KMS-backed provider drops in without changes here.
    const { keyId, wrapped } = this.deps.master.wrap(key);
    const now = this.deps.clock.now();
    await this.deps.db
      .insert(workspaceKey)
      .values({ workspaceId, version, wrappedKey: wrapped, masterKeyId: keyId })
      .onConflictDoUpdate({
        target: workspaceKey.workspaceId,
        set: { version, wrappedKey: wrapped, masterKeyId: keyId, rotatedAt: now },
      });
    if (!raw) key.fill(0);
  }

  private async credentialBlobs(workspaceId: string): Promise<BlobRef[]> {
    const out: BlobRef[] = [];
    const accounts = await this.deps.db
      .select()
      .from(socialAccount)
      .where(
        and(eq(socialAccount.workspaceId, workspaceId), isNotNull(socialAccount.accessTokenEnc)),
      );
    for (const a of accounts) {
      if (a.accessTokenEnc)
        out.push({
          table: 'social_account',
          id: a.id,
          column: 'access_token',
          blob: a.accessTokenEnc,
        });
      if (a.refreshTokenEnc)
        out.push({
          table: 'social_account',
          id: a.id,
          column: 'refresh_token',
          blob: a.refreshTokenEnc,
        });
    }
    const sources = await this.deps.db
      .select()
      .from(contentSource)
      .where(
        and(eq(contentSource.workspaceId, workspaceId), isNotNull(contentSource.credentialEnc)),
      );
    for (const s of sources)
      if (s.credentialEnc)
        out.push({
          table: 'content_source',
          id: s.id,
          column: 'credential',
          blob: s.credentialEnc,
        });
    const hooks = await this.deps.db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.workspaceId, workspaceId));
    for (const h of hooks)
      out.push({ table: 'webhook_endpoint', id: h.id, column: 'secret', blob: h.secretEnc });
    const [sso] = await this.deps.db
      .select()
      .from(ssoConnection)
      .where(eq(ssoConnection.workspaceId, workspaceId))
      .limit(1);
    if (sso)
      out.push({
        table: 'sso_connection',
        id: sso.workspaceId,
        column: 'client_secret',
        blob: sso.clientSecretEnc,
      });
    return out;
  }

  private async resealAll(workspaceId: string): Promise<void> {
    if (!this.vault) throw new Error('vault not attached');
    const blobs = await this.credentialBlobs(workspaceId);
    const current = await this.providerFor(workspaceId);
    const resealed = await this.resealWith(workspaceId, this.deps.master, current, blobs);
    await this.writeBlobs(resealed, current.currentKeyId);
  }

  private async resealWith(
    workspaceId: string,
    from: KeyProvider,
    to: KeyProvider,
    blobs?: BlobRef[],
  ): Promise<BlobRef[]> {
    const { open, seal } = await import('../../infra/crypto/envelope.js');
    const list = blobs ?? (await this.credentialBlobs(workspaceId));
    return list.map((b) => {
      const aad = `${b.table}.${b.column}:${b.id}`;
      const plaintext = open(from, b.blob, aad);
      return { ...b, blob: seal(to, plaintext, aad) };
    });
  }

  private async writeBlobs(blobs: BlobRef[], keyId: string): Promise<void> {
    const now = this.deps.clock.now();
    for (const b of blobs) {
      switch (b.table) {
        case 'social_account':
          await this.deps.db
            .update(socialAccount)
            .set(
              b.column === 'access_token'
                ? { accessTokenEnc: b.blob, credentialKeyId: keyId, updatedAt: now }
                : { refreshTokenEnc: b.blob, credentialKeyId: keyId, updatedAt: now },
            )
            .where(eq(socialAccount.id, b.id));
          break;
        case 'content_source':
          await this.deps.db
            .update(contentSource)
            .set({ credentialEnc: b.blob, credentialKeyId: keyId, updatedAt: now })
            .where(eq(contentSource.id, b.id));
          break;
        case 'webhook_endpoint':
          await this.deps.db
            .update(webhookEndpoint)
            .set({ secretEnc: b.blob, updatedAt: now })
            .where(eq(webhookEndpoint.id, b.id));
          break;
        case 'sso_connection':
          await this.deps.db
            .update(ssoConnection)
            .set({ clientSecretEnc: b.blob, updatedAt: now })
            .where(eq(ssoConnection.workspaceId, b.id));
          break;
      }
    }
  }
}

interface BlobRef {
  table: 'social_account' | 'content_source' | 'webhook_endpoint' | 'sso_connection';
  id: string;
  column: string;
  blob: Buffer;
}
