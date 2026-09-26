import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { contentSource, type ContentSource } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { CredentialReason, CredentialVault } from '../connections/credential-vault.js';
import { ConnectionError } from '../connections/social-account.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  NotionApiError,
  NotionClient,
  type NotionDatabase,
  type NotionSearchResult,
} from './notion/notion-client.js';
import {
  CAMPAIGNS_TITLE,
  IDEAS_TITLE,
  TEMPLATE_TITLE,
  createTemplateSuite,
} from './notion/notion-template.js';
import {
  CAMPAIGN_CONTRACT,
  IDEAS_CONTRACT,
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
  /** Phase 3 */
  authKind: 'oauth' | 'token';
  setupPending: boolean;
  notionWorkspaceName: string | null;
  /** Phase 4 */
  templateVersion: 1 | 2;
  campaignsDatabaseId: string | null;
  ideasDatabaseId: string | null;
}

interface NotionSourceConfig {
  propertyMap?: Record<string, string>;
  warnings?: SchemaIssue[];
  pollIntervalSeconds?: number;
  /** Phase 3: `oauth` for the public integration, otherwise a pasted internal token. */
  authKind?: 'oauth' | 'token';
  notionBotId?: string;
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  duplicatedTemplateId?: string | null;
  /** True between the OAuth callback and the setup wizard choosing a database. */
  setupPending?: boolean;
  setupMode?: 'create' | 'existing';
  /** Phase 4 companions: null when the database has none. */
  campaignsDatabaseId?: string | null;
  campaignPropertyMap?: Record<string, string>;
  ideasDatabaseId?: string | null;
  ideasPropertyMap?: Record<string, string>;
  /** 2 when the `Repeat`/`Campaign`/`First Comment` columns exist. */
  templateVersion?: 1 | 2;
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
    authKind: cfg.authKind ?? 'token',
    setupPending: cfg.setupPending === true,
    notionWorkspaceName: cfg.notionWorkspaceName ?? null,
    templateVersion: cfg.templateVersion ?? 1,
    campaignsDatabaseId: cfg.campaignsDatabaseId ?? null,
    ideasDatabaseId: cfg.ideasDatabaseId ?? null,
  };
}

/** Phase 4: companion databases discovered next to a content database. */
async function companionDatabases(
  client: NotionClient,
  db: NotionDatabase,
  propertyMap: Record<string, string>,
  explicitIdeasId: string | null,
): Promise<
  Pick<
    NotionSourceConfig,
    | 'campaignsDatabaseId'
    | 'campaignPropertyMap'
    | 'ideasDatabaseId'
    | 'ideasPropertyMap'
    | 'templateVersion'
  >
> {
  const out: Pick<
    NotionSourceConfig,
    | 'campaignsDatabaseId'
    | 'campaignPropertyMap'
    | 'ideasDatabaseId'
    | 'ideasPropertyMap'
    | 'templateVersion'
  > = {
    campaignsDatabaseId: null,
    ideasDatabaseId: null,
    templateVersion: propertyMap['Repeat'] || propertyMap['First Comment'] ? 2 : 1,
  };
  const campaignProp = propertyMap['Campaign'] ? db.properties[propertyMap['Campaign']] : undefined;
  if (campaignProp?.relationDatabaseId) {
    try {
      const cdb = await client.retrieveDatabase(campaignProp.relationDatabaseId);
      const v = validateNotionDatabase(cdb, CAMPAIGN_CONTRACT);
      if (v.ok) {
        out.campaignsDatabaseId = cdb.id;
        out.campaignPropertyMap = v.propertyMap;
      }
    } catch {
      // The relation points somewhere we cannot read; campaigns stay off.
    }
  }
  let ideasId = explicitIdeasId;
  if (!ideasId) {
    try {
      const found = (await client.search('database')).find(
        (d) => d.title.trim().toLowerCase() === IDEAS_TITLE.toLowerCase(),
      );
      ideasId = found?.id ?? null;
    } catch {
      ideasId = null;
    }
  }
  if (ideasId) {
    try {
      const idb = await client.retrieveDatabase(ideasId);
      const v = validateNotionDatabase(idb, IDEAS_CONTRACT);
      if (v.ok) {
        out.ideasDatabaseId = idb.id;
        out.ideasPropertyMap = v.propertyMap;
      }
    } catch {
      // Ignore: ideas are optional.
    }
  }
  return out;
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

    const companions = await companionDatabases(client, db, validation.propertyMap, null);
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
      // Pending OAuth sources (no database yet, status disabled) do not count as connected.
      const other = active.find(
        (s) => s.externalDatabaseId !== null && s.externalDatabaseId !== databaseId,
      );
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
        ...companions,
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

  /**
   * "Connect with Notion" (Phase 3): stores the OAuth bot token as a pending
   * source (no database yet, status `disabled`) for the setup wizard to complete.
   * Reconnecting the same Notion workspace refreshes the token of its source.
   */
  async connectNotionOAuth(
    ctx: TenantContext,
    tokens: {
      accessToken: string;
      botId: string;
      workspaceId: string | null;
      workspaceName: string | null;
      duplicatedTemplateId: string | null;
    },
  ): Promise<ContentSourceDto> {
    const userId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    const now = new Date();
    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const rows = await tx
        .select()
        .from(contentSource)
        .where(
          and(
            eq(contentSource.workspaceId, ctx.workspaceId),
            eq(contentSource.kind, 'notion'),
            isNull(contentSource.disconnectedAt),
          ),
        );
      const existing = rows.find(
        (s) => (s.config as NotionSourceConfig).notionBotId === tokens.botId,
      );
      const id = existing?.id ?? uuidv7();
      const prevConfig = (existing?.config ?? {}) as NotionSourceConfig;
      const config: NotionSourceConfig = {
        ...prevConfig,
        authKind: 'oauth',
        notionBotId: tokens.botId,
        notionWorkspaceId: tokens.workspaceId,
        notionWorkspaceName: tokens.workspaceName,
        duplicatedTemplateId: tokens.duplicatedTemplateId,
        setupPending: existing?.externalDatabaseId ? false : true,
      };
      const values = {
        credentialEnc: this.deps.vault.seal(
          { entityType: 'content_source', entityId: id, column: 'credential' },
          tokens.accessToken,
        ),
        credentialKeyId: this.deps.vault.currentKeyId,
        config,
        lastError: null,
        connectedByUserId: userId,
        updatedAt: now,
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
            status: 'disabled',
            externalDatabaseId: null,
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
        toState: row.status,
        correlationId: ctx.correlationId,
        data: {
          kind: 'notion',
          authKind: 'oauth',
          notionWorkspaceName: tokens.workspaceName,
          setupPending: config.setupPending,
        },
      });
      return toContentSourceDto(row);
    });
  }

  /** Setup wizard data: pages the integration can create the template in, and databases it could adopt. */
  async setupOptions(
    ctx: TenantContext,
    sourceId: string,
  ): Promise<{
    pages: NotionSearchResult[];
    databases: NotionSearchResult[];
    /** Phase 4: the databases of a duplicated Postelyo template, when found by title. */
    suggested: {
      contentDatabaseId: string;
      campaignsDatabaseId: string | null;
      ideasDatabaseId: string | null;
    } | null;
  }> {
    return this.withToken(ctx, sourceId, 'validate_connection', async (token) => {
      const client = new NotionClient(token, { fetchImpl: this.deps.fetchImpl ?? fetch });
      const [pages, databases] = await Promise.all([
        client.search('page'),
        client.search('database'),
      ]);
      const byTitle = (title: string) =>
        databases.find((d) => d.title.trim().toLowerCase() === title.toLowerCase()) ?? null;
      const content = byTitle(TEMPLATE_TITLE);
      const suggested = content
        ? {
            contentDatabaseId: content.id,
            campaignsDatabaseId: byTitle(CAMPAIGNS_TITLE)?.id ?? null,
            ideasDatabaseId: byTitle(IDEAS_TITLE)?.id ?? null,
          }
        : null;
      return { pages, databases, suggested };
    });
  }

  /**
   * Completes a pending OAuth source: creates the template under `parentPageId`
   * or validates and adopts `databaseId`, then activates the source.
   */
  async completeSetup(
    ctx: TenantContext,
    sourceId: string,
    choice:
      | { mode: 'create'; parentPageId: string; title?: string | undefined }
      | { mode: 'existing'; databaseId: string; ideasDatabaseId?: string | undefined },
  ): Promise<ContentSourceDto> {
    const source = await this.get(ctx, sourceId);
    if (!source || source.disconnectedAt || source.kind !== 'notion' || !source.credentialEnc) {
      throw new ConnectionError('not_found', 'content source not found');
    }
    if (source.externalDatabaseId) {
      throw new ConnectionError(
        'already_connected',
        'This Notion connection is already set up. Disconnect it to start over.',
      );
    }
    const result = await this.withToken(ctx, sourceId, 'validate_connection', async (token) => {
      const client = new NotionClient(token, { fetchImpl: this.deps.fetchImpl ?? fetch });
      let databaseId: string;
      if (choice.mode === 'create') {
        const parent = parseNotionDatabaseId(choice.parentPageId);
        if (!parent) {
          throw new ContentSourceValidationError(
            'invalid_database_id',
            'Choose a page to create the database in.',
          );
        }
        try {
          databaseId = (await createTemplateSuite(client, parent, choice.title ?? TEMPLATE_TITLE))
            .contentDatabaseId;
        } catch (err) {
          if (err instanceof NotionApiError)
            throw new ContentSourceValidationError('notion_error', err.message);
          throw err;
        }
      } else {
        const parsed = parseNotionDatabaseId(choice.databaseId);
        if (!parsed)
          throw new ContentSourceValidationError('invalid_database_id', 'Choose a database.');
        databaseId = parsed;
      }
      let db;
      try {
        db = await client.retrieveDatabase(databaseId);
      } catch (err) {
        if (err instanceof NotionApiError)
          throw new ContentSourceValidationError('notion_error', err.message);
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
      const companions = await companionDatabases(
        client,
        db,
        validation.propertyMap,
        choice.mode === 'existing' ? (choice.ideasDatabaseId ?? null) : null,
      );
      return { databaseId, db, validation, companions };
    });

    return withTenantScope(this.deps.db, ctx.workspaceId, async (tx) => {
      const others = await tx
        .select()
        .from(contentSource)
        .where(
          and(
            eq(contentSource.workspaceId, ctx.workspaceId),
            eq(contentSource.kind, 'notion'),
            isNull(contentSource.disconnectedAt),
            eq(contentSource.status, 'active'),
          ),
        );
      const other = others.find(
        (s) => s.id !== sourceId && s.externalDatabaseId !== result.databaseId,
      );
      if (other) {
        throw new ConnectionError(
          'already_connected',
          `Another Notion database (${other.externalDatabaseTitle ?? other.externalDatabaseId}) is already connected. Disconnect it first.`,
        );
      }
      const config: NotionSourceConfig = {
        ...((source.config ?? {}) as NotionSourceConfig),
        propertyMap: result.validation.propertyMap,
        warnings: result.validation.warnings,
        pollIntervalSeconds: 60,
        setupPending: false,
        setupMode: choice.mode,
        ...result.companions,
      };
      const [row] = await tx
        .update(contentSource)
        .set({
          status: 'active',
          externalDatabaseId: result.databaseId,
          externalDatabaseTitle: result.db.title || null,
          config,
          cursor: {},
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(contentSource.id, sourceId))
        .returning();
      await recordAudit(tx, {
        workspaceId: ctx.workspaceId,
        actor: ctx.actor,
        entityType: 'content_source',
        entityId: sourceId,
        event: 'content_source.setup_completed',
        toState: 'active',
        correlationId: ctx.correlationId,
        data: {
          mode: choice.mode,
          databaseId: result.databaseId,
          databaseTitle: result.db.title,
          warnings: result.validation.warnings.map((w) => w.message),
        },
      });
      return toContentSourceDto(row!);
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
