import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { contentSource, type ContentSource } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { CredentialReason, CredentialVault } from '../connections/credential-vault.js';
import { ConnectionError } from '../connections/social-account.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { NotionApiError, NotionClient } from './notion/notion-client.js';
import {
  parseNotionDatabaseId,
  validateNotionDatabase,
  type SchemaIssue,
} from './notion/notion-schema.js';

export class ContentSourceValidationError extends Error {
  constructor(
    public readonly code: 'invalid_database_id' | 'notion_error' | 'schema_invalid',
    message: string,
    public readonly issues: SchemaIssue[] = [],
  ) {
    super(message);
    this.name = 'ContentSourceValidationError';
  }
}

export interface ContentSourceDto {
  id: string;
  kind: ContentSource['kind'];
  status: ContentSource['status'];
  databaseId: string | null;
  databaseTitle: string | null;
  warnings: SchemaIssue[];
  lastSyncAt: Date | null;
  lastError: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

interface NotionSourceConfig {
  propertyMap?: Record<string, string>;
  warnings?: SchemaIssue[];
  pollIntervalSeconds?: number;
}

export function toContentSourceDto(s: ContentSource): ContentSourceDto {
  const cfg = (s.config ?? {}) as NotionSourceConfig;
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    databaseId: s.externalDatabaseId,
    databaseTitle: s.externalDatabaseTitle,
    warnings: cfg.warnings ?? [],
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError,
    connectedAt: s.createdAt,
    disconnectedAt: s.disconnectedAt,
  };
}

export interface ContentSourceServiceDeps {
  db: Db;
  vault: CredentialVault;
  fetchImpl?: typeof fetch;
}

/**
 * Content sources (domain-model §2.4). MVP: one active Notion database per
 * workspace; connecting validates the database against the contract first.
 */
export class ContentSourceService {
  constructor(private readonly deps: ContentSourceServiceDeps) {}

  async list(ctx: TenantContext): Promise<ContentSourceDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(contentSource)
        .where(eq(contentSource.workspaceId, ctx.workspaceId))
        .orderBy(contentSource.createdAt),
    );
    return rows.map(toContentSourceDto);
  }

  async get(ctx: TenantContext, id: string): Promise<ContentSource | null> {
    const [row] = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(contentSource)
        .where(and(eq(contentSource.workspaceId, ctx.workspaceId), eq(contentSource.id, id)))
        .limit(1),
    );
    return row ?? null;
  }

  /**
   * Validates token + database against Notion, then stores the token encrypted.
   * Re-connecting the same database updates the token; a second active Notion
   * database in the workspace is rejected (MVP).
   */
  async connectNotion(
    ctx: TenantContext,
    input: { token: string; database: string },
  ): Promise<ContentSourceDto> {
    const databaseId = parseNotionDatabaseId(input.database);
    if (!databaseId) {
      throw new ContentSourceValidationError(
        'invalid_database_id',
        'Enter the database URL from Notion or its 32-character id.',
      );
    }
    const token = input.token.trim();
    if (token.length < 20) {
      throw new ContentSourceValidationError(
        'notion_error',
        'The integration token looks too short.',
      );
    }

    const client = new NotionClient(token, { fetchImpl: this.deps.fetchImpl ?? fetch });
    let db;
    try {
      db = await client.retrieveDatabase(databaseId);
    } catch (err) {
      if (err instanceof NotionApiError) {
        throw new ContentSourceValidationError('notion_error', err.message);
      }
      throw err;
    }
    const validation = validateNotionDatabase(db);
    if (!validation.ok) {
      throw new ContentSourceValidationError(
        'schema_invalid',
        'The Notion database does not match the Postelyo template.',
        validation.errors,
      );
    }

    const userId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const active = await tx
        .select()
        .from(contentSource)
        .where(
          and(
            eq(contentSource.workspaceId, ctx.workspaceId),
            eq(contentSource.kind, 'notion'),
            isNull(contentSource.disconnectedAt),
          ),
        );
      const other = active.find((s) => s.externalDatabaseId !== databaseId);
      if (other) {
        throw new ConnectionError(
          'already_connected',
          `Another Notion database (${other.externalDatabaseTitle ?? other.externalDatabaseId}) is already connected. Disconnect it first.`,
        );
      }
      const [existing] = await tx
        .select()
        .from(contentSource)
        .where(
          and(
            eq(contentSource.workspaceId, ctx.workspaceId),
            eq(contentSource.kind, 'notion'),
            eq(contentSource.externalDatabaseId, databaseId),
          ),
        )
        .limit(1);

      const id = existing?.id ?? uuidv7();
      const config: NotionSourceConfig = {
        propertyMap: validation.propertyMap,
        warnings: validation.warnings,
        pollIntervalSeconds: 60,
      };
      const values = {
        status: 'active' as const,
        externalDatabaseTitle: db.title || null,
        credentialEnc: this.deps.vault.seal(
          { entityType: 'content_source', entityId: id, column: 'credential' },
          token,
        ),
        credentialKeyId: this.deps.vault.currentKeyId,
        config,
        lastError: null,
        connectedByUserId: userId,
        disconnectedAt: null,
        updatedAt: new Date(),
      };

      let row: ContentSource;
      if (existing) {
        const [updated] = await tx
          .update(contentSource)
          .set(values)
          .where(eq(contentSource.id, existing.id))
          .returning();
        row = updated!;
      } else {
        const [inserted] = await tx
          .insert(contentSource)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            kind: 'notion',
            externalDatabaseId: databaseId,
            ...values,
          })
          .returning();
        row = inserted!;
      }

      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: row.id,
        event: existing ? 'content_source.updated' : 'content_source.connected',
        toState: 'active',
        correlationId: ctx.correlationId,
        data: {
          kind: 'notion',
          databaseId,
          databaseTitle: db.title,
          warnings: validation.warnings.map((w) => w.message),
        },
      });
      return toContentSourceDto(row);
    });
  }

  async disconnect(ctx: TenantContext, id: string): Promise<void> {
    await withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const [row] = await tx
        .update(contentSource)
        .set({
          status: 'disabled',
          credentialEnc: null,
          credentialKeyId: null,
          disconnectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contentSource.workspaceId, ctx.workspaceId),
            eq(contentSource.id, id),
            isNull(contentSource.disconnectedAt),
          ),
        )
        .returning({ id: contentSource.id });
      if (!row) throw new ConnectionError('not_found', 'content source not found');
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: id,
        event: 'content_source.disconnected',
        toState: 'disabled',
        correlationId: ctx.correlationId,
      });
    });
  }

  /** Runs `fn` with the decrypted Notion token; access is audited with `reason`. */
  async withToken<T>(
    ctx: TenantContext,
    id: string,
    reason: CredentialReason,
    fn: (token: string, source: ContentSource) => Promise<T>,
  ): Promise<T> {
    const source = await this.get(ctx, id);
    if (!source) throw new ConnectionError('not_found', 'content source not found');
    if (!source.credentialEnc) throw new ConnectionError('no_credentials', 'source has no token');
    return this.deps.vault.withCredential(
      ctx,
      { entityType: 'content_source', entityId: id, column: 'credential' },
      source.credentialEnc,
      reason,
      (token) => fn(token, source),
    );
  }
}
