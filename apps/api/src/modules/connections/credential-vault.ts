import type { Db } from '../../infra/db/client.js';
import { open, seal } from '../../infra/crypto/envelope.js';
import type { KeyProvider } from '../../infra/crypto/key-provider.js';
import { recordAudit, type AuditEntityType } from '../audit/audit.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

export type CredentialReason = 'publish' | 'refresh' | 'validate_connection' | 'sync' | 'revoke';

export interface CredentialRef {
  entityType: Extract<AuditEntityType, 'social_account' | 'content_source'>;
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
  ) {}

  get currentKeyId(): string {
    return this.keys.currentKeyId;
  }

  seal(ref: CredentialRef, plaintext: string): Buffer {
    return seal(this.keys, plaintext, aadFor(ref));
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
    const plaintext = open(this.keys, blob, aadFor(ref));
    return fn(plaintext);
  }
}

function aadFor(ref: CredentialRef): string {
  return `${ref.entityType}.${ref.column}:${ref.entityId}`;
}
