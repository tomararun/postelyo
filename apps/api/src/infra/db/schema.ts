import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema. Mirrors docs/domain-model.md; every tenant-owned table added
 * later must carry `workspace_id` as the leading column of its main indexes.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Envelope-encrypted secret (see infra/crypto/envelope.ts). Never selected into DTOs. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v),
});

// ---------------------------------------------------------------------------
// Tenant boundary (domain-model §2.1)
// ---------------------------------------------------------------------------

export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** IANA time zone, e.g. Europe/Berlin. Required for scheduling. */
  defaultTimezone: text('default_timezone').notNull(),
  /** Local wall-clock used when a source date has no time. */
  defaultPublishTime: time('default_publish_time').notNull().default('09:00'),
  plan: text('plan').notNull().default('free'),
  settings: jsonb('settings').notNull().default({ v: 1 }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  ...timestamps,
});

export type Workspace = typeof workspace.$inferSelect;
export type NewWorkspace = typeof workspace.$inferInsert;

// ---------------------------------------------------------------------------
// Identity (domain-model §2.2). Column shapes are dictated by Better Auth;
// keys are camelCase (adapter lookup), columns are snake_case.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  ...timestamps,
});

export type User = typeof user.$inferSelect;

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Membership (domain-model §2.3)
// ---------------------------------------------------------------------------

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'editor', 'viewer']);

export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('membership_workspace_user_uq').on(t.workspaceId, t.userId),
    index('membership_user_id_idx').on(t.userId),
  ],
);

export type Membership = typeof membership.$inferSelect;

// ---------------------------------------------------------------------------
// Connections (domain-model §2.4, §2.5, §2.11)
// ---------------------------------------------------------------------------

export const socialProvider = pgEnum('social_provider', ['linkedin', 'x', 'instagram', 'facebook']);
export const socialAccountStatus = pgEnum('social_account_status', [
  'active',
  'needs_reauth',
  'revoked',
  'disabled',
]);

export const socialAccount = pgTable(
  'social_account',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    provider: socialProvider('provider').notNull(),
    /** `member` (personal profile) or `organization` (LinkedIn Page). */
    accountType: text('account_type').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    status: socialAccountStatus('status').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    accessTokenEnc: bytea('access_token_enc'),
    refreshTokenEnc: bytea('refresh_token_enc'),
    credentialKeyId: text('credential_key_id'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    connectedByUserId: uuid('connected_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** When the "expires in 7 days" reminder for the current token was sent (reset on reconnect). */
    reauthReminderSentAt: timestamp('reauth_reminder_sent_at', { withTimezone: true }),
    /** When the "needs re-authorization" notice was sent (reset on reconnect). */
    reauthNotifiedAt: timestamp('reauth_notified_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('social_account_provider_uq').on(t.workspaceId, t.provider, t.providerAccountId),
    index('social_account_workspace_idx').on(t.workspaceId, t.status),
  ],
);

export type SocialAccount = typeof socialAccount.$inferSelect;

export const oauthState = pgTable(
  'oauth_state',
  {
    /** The opaque `state` value itself. */
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: socialProvider('provider').notNull(),
    pkceVerifier: text('pkce_verifier'),
    /** What the flow connects: `member` (profile) or `organization` (pages the member administers). */
    accountType: text('account_type').notNull().default('member'),
    /** Same-origin path to return to after the callback. */
    redirectTo: text('redirect_to').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_state_expires_idx').on(t.expiresAt)],
);

export const contentSourceKind = pgEnum('content_source_kind', ['notion', 'native']);
export const contentSourceStatus = pgEnum('content_source_status', ['active', 'error', 'disabled']);

export const contentSource = pgTable(
  'content_source',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    kind: contentSourceKind('kind').notNull(),
    status: contentSourceStatus('status').notNull(),
    /** Notion database id (dashed uuid). Null for `native`. */
    externalDatabaseId: text('external_database_id'),
    externalDatabaseTitle: text('external_database_title'),
    credentialEnc: bytea('credential_enc'),
    credentialKeyId: text('credential_key_id'),
    /** Non-secret configuration: property map, poll interval, validation warnings. */
    config: jsonb('config').notNull().default({}),
    /** Incremental sync cursor (milestone 0.4). */
    cursor: jsonb('cursor').notNull().default({}),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    /** Sanitized; never contains secrets. */
    lastError: text('last_error'),
    connectedByUserId: uuid('connected_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('content_source_database_uq').on(t.workspaceId, t.kind, t.externalDatabaseId),
    index('content_source_workspace_idx').on(t.workspaceId, t.status),
  ],
);

export type ContentSource = typeof contentSource.$inferSelect;

// ---------------------------------------------------------------------------
// Content (domain-model §2.6, §2.7, §2.9)
// ---------------------------------------------------------------------------

export const postState = pgEnum('post_state', [
  'draft',
  'in_review',
  'changes_requested',
  'ready',
  'scheduled',
  'publishing',
  'published',
  'partially_failed',
  'failed',
  'cancelled',
]);

export const post = pgTable(
  'post',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    contentSourceId: uuid('content_source_id').references(() => contentSource.id, {
      onDelete: 'set null',
    }),
    /** Notion page id. */
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    title: text('title').notNull(),
    state: postState('state').notNull(),
    /** Raw status last observed in the source (e.g. "In review"). */
    sourceStatus: text('source_status'),
    /** Canonical content snapshot (modules/posts/content.ts). */
    content: jsonb('content').notNull().default({}),
    contentHash: text('content_hash').notNull().default(''),
    sourceEditedAt: timestamp('source_edited_at', { withTimezone: true }),
    requestedPlatforms: text('requested_platforms').array().notNull().default([]),
    /** Wall-clock as the user entered it, e.g. "2026-10-01T09:00". */
    requestedPublishLocal: text('requested_publish_local'),
    requestedTimezone: text('requested_timezone'),
    validationErrors: jsonb('validation_errors'),
    /** Non-blocking notes surfaced to the source (drift, DST adjustments). */
    warnings: jsonb('warnings').notNull().default([]),
    cycleNo: integer('cycle_no').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('post_source_external_uq').on(t.contentSourceId, t.externalId),
    index('post_workspace_state_idx').on(t.workspaceId, t.state),
  ],
);

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const publicationState = pgEnum('publication_state', [
  'pending',
  'scheduled',
  'blocked',
  'queued',
  'publishing',
  'retry_wait',
  'published',
  'failed',
  'ambiguous',
  'cancelled',
]);

export const writebackState = pgEnum('writeback_state', ['pending', 'done', 'failed']);

export const publication = pgTable(
  'publication',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    socialAccountId: uuid('social_account_id')
      .notNull()
      .references(() => socialAccount.id, { onDelete: 'restrict' }),
    provider: socialProvider('provider').notNull(),
    state: publicationState('state').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    scheduledTz: text('scheduled_tz').notNull(),
    scheduledLocal: text('scheduled_local').notNull(),
    contentOverride: jsonb('content_override'),
    cycleNo: integer('cycle_no').notNull().default(0),
    attemptNo: integer('attempt_no').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    publishingAt: timestamp('publishing_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    delaySeconds: integer('delay_seconds'),
    /** Set while a `scheduled` row waits for an account's daily cap or a provider rate limit to clear. */
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    /** Automatic reconciliation checks made while `ambiguous`; capped so the operator is never starved. */
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    providerPostId: text('provider_post_id'),
    providerPostUrl: text('provider_post_url'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    writebackState: writebackState('writeback_state').notNull().default('pending'),
    writebackAttempts: integer('writeback_attempts').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('publication_post_account_uq').on(t.postId, t.socialAccountId),
    uniqueIndex('publication_provider_post_uq')
      .on(t.socialAccountId, t.providerPostId)
      .where(sql`${t.providerPostId} is not null`),
    index('publication_due_idx').on(t.state, t.scheduledAt),
    index('publication_workspace_state_idx').on(t.workspaceId, t.state),
  ],
);

export type Publication = typeof publication.$inferSelect;

export const attemptOutcome = pgEnum('attempt_outcome', [
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'unknown',
]);

/** One provider call for a publication (domain-model §2.8). Append-only. */
export const publishAttempt = pgTable(
  'publish_attempt',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    publicationId: uuid('publication_id')
      .notNull()
      .references(() => publication.id, { onDelete: 'cascade' }),
    cycleNo: integer('cycle_no').notNull(),
    attemptNo: integer('attempt_no').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** Null while in flight; stays null when the worker died mid-call (→ ambiguous). */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: attemptOutcome('outcome'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Original intent, copied from the publication at attempt time. */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    delaySeconds: integer('delay_seconds'),
    /** Endpoint, api version, correlation id, content hash — never tokens or content. */
    requestMeta: jsonb('request_meta').notNull().default({}),
    /** Status and headers of interest; body truncated to 4 KB. */
    responseMeta: jsonb('response_meta'),
    workerId: text('worker_id').notNull(),
  },
  (t) => [index('publish_attempt_publication_idx').on(t.publicationId, t.startedAt)],
);

export type PublishAttempt = typeof publishAttempt.$inferSelect;

export const mediaAsset = pgTable(
  'media_asset',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    /** Source file URL as last seen (Notion-hosted URLs expire; re-read at publish time). */
    sourceUrl: text('source_url').notNull(),
    sourceKind: text('source_kind').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    /** sha256 of the bytes once fetched; null until inspected. */
    contentHash: text('content_hash'),
    /** Sanitized reason when the file could not be used (too large, not an image, unreachable). */
    lastError: text('last_error'),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    /** Provider upload references keyed by provider, e.g. { linkedin: { ref: "urn:li:image:…", contentHash } }. */
    providerRefs: jsonb('provider_refs').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('media_asset_post_idx').on(t.postId)],
);

export type MediaAsset = typeof mediaAsset.$inferSelect;

// ---------------------------------------------------------------------------
// Operations (architecture §10.4, §19)
// ---------------------------------------------------------------------------

/** Alert de-duplication: one row per (kind, entity); a send is allowed when the window elapsed. */
export const alertState = pgTable(
  'alert_state',
  {
    kind: text('kind').notNull(),
    entityKey: text('entity_key').notNull(),
    workspaceId: uuid('workspace_id'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
    sendCount: integer('send_count').notNull().default(1),
    lastMessage: text('last_message'),
  },
  (t) => [primaryKey({ columns: [t.kind, t.entityKey] })],
);

/** Liveness of worker processes; the api alerts when none has reported recently. */
export const workerHeartbeat = pgTable('worker_heartbeat', {
  instanceId: text('instance_id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  version: text('version'),
});

// ---------------------------------------------------------------------------
// Inbound webhooks (architecture §11.1, domain-model §2.12)
// ---------------------------------------------------------------------------

/** Raw inbound webhook events, idempotent on the provider's event id; processed asynchronously. */
export const webhookEvent = pgTable(
  'webhook_event',
  {
    id: uuid('id').primaryKey(),
    /** Null until the event was matched to a workspace (or when it never matches). */
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    /** Provider-side id of the entity the event is about (Notion page id). */
    entityId: text('entity_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** Raw payload, size-limited by the route. Never contains our secrets. */
    payload: jsonb('payload').notNull().default({}),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    /** `enqueued`, or `ignored:<reason>`. */
    outcome: text('outcome'),
  },
  (t) => [
    uniqueIndex('webhook_event_source_external_uq').on(t.source, t.externalEventId),
    index('webhook_event_received_idx').on(t.receivedAt),
  ],
);

export type WebhookEvent = typeof webhookEvent.$inferSelect;

// ---------------------------------------------------------------------------
// Audit log (domain-model §2.10). Append-only.
// ---------------------------------------------------------------------------

export const auditActorType = pgEnum('audit_actor_type', ['user', 'system', 'webhook', 'api_key']);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /** Null for global events such as sign-in. */
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorType('actor_type').notNull(),
    actorId: text('actor_id'),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    event: text('event').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    correlationId: text('correlation_id'),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.workspaceId, t.entityType, t.entityId, t.occurredAt),
    index('audit_log_correlation_idx').on(t.correlationId),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
