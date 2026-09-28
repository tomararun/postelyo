import type { Db } from '../../infra/db/client.js';
import { open, seal } from '../../infra/crypto/envelope.js';
import type { KeyProvider } from '../../infra/crypto/key-provider.js';
import type { TenantKeyService } from '../enterprise/tenant-key.service.js';
import { recordAudit, type AuditEntityType } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type CredentialReason = 'publish' | 'refresh' | 'validate_connection' | 'sync' | 'revoke';

export interface CredentialRef {
  entityType: Extract<
    AuditEntityType,
    'social_account' | 'content_source' | 'webhook_endpoint' | 'sso_connection'
  >;
  entityId: string;
  column: string;
}

/**
 * The only path to plaintext credentials (security.md §6.3). `seal` encrypts for
 * storage; `open` decrypts and writes a `credential.accessed` audit row with the
 * reason (never the value). Callers hold the plaintext only inside `fn`.
 */
export class CredentialVault {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    /** Phase 7: per-tenant keys for enterprise workspaces; master key otherwise. */
    private readonly tenantKeys?: TenantKeyService,
  ) {}

  get currentKeyId(): string {
    return this.keys.currentKeyId;
  }

  /** Master-key seal (seed tooling and global secrets). Tenant data uses `sealFor`. */
  seal(ref: CredentialRef, plaintext: string): Buffer {
    return seal(this.keys, plaintext, aadFor(ref));
  }

  private async providerFor(workspaceId: string): Promise<KeyProvider> {
    return this.tenantKeys ? this.tenantKeys.providerFor(workspaceId) : this.keys;
  }

  /** Seals with the workspace's own key when it has one (enterprise), else the master key. */
  async sealFor(workspaceId: string, ref: CredentialRef, plaintext: string): Promise<Buffer> {
    return seal(await this.providerFor(workspaceId), plaintext, aadFor(ref));
  }

  async keyIdFor(workspaceId: string): Promise<string> {
    return (await this.providerFor(workspaceId)).currentKeyId;
  }

  /** Re-seals an existing blob under the workspace's current key (rotation, enabling tenant keys). */
  async reseal(workspaceId: string, ref: CredentialRef, blob: Buffer): Promise<Buffer> {
    const plaintext = open(await this.providerFor(workspaceId), blob, aadFor(ref));
    try {
      return seal(await this.providerFor(workspaceId), plaintext, aadFor(ref));
    } finally {
      // Strings are immutable; nothing to zero. Callers never see the plaintext.
    }
  }

  async withCredential<T>(
    ctx: TenantContext,
    ref: CredentialRef,
    blob: Buffer,
    reason: CredentialReason,
    fn: (plaintext: string) => Promise<T>,
  ): Promise<T> {
    await recordAudit(this.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: ref.entityType,
      entityId: ref.entityId,
      event: 'credential.accessed',
      correlationId: ctx.correlationId,
      data: { column: ref.column, reason },
    });
    const plaintext = open(await this.providerFor(ctx.workspaceId), blob, aadFor(ref));
    return fn(plaintext);
  }
}

function aadFor(ref: CredentialRef): string {
  return `${ref.entityType}.${ref.column}:${ref.entityId}`;
}
