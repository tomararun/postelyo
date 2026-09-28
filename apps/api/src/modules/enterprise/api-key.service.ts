import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { apiKey, idempotencyKey, type ApiKey } from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { BillingService } from '../billing/billing.service.js';
import { planHas } from '../billing/plans.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 7 public API keys. `pk_live_<43 url-safe chars>`; only the SHA-256
 * hash is stored, the secret is returned once. Scopes: `read` (list and get),
 * `write` (create posts, retry, manage webhooks). Rate limiting is a token
 * bucket per key held in memory (per api instance); idempotency replays are
 * stored for 24 hours.
 */

export type ApiScope = 'read' | 'write';
export const API_SCOPES: readonly ApiScope[] = ['read', 'write'];
export const API_KEY_PREFIX = 'pk_live_';
/** Requests per minute per key. */
export const API_RATE_LIMIT_PER_MINUTE = 60;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export class ApiKeyError extends Error {
  constructor(
    public readonly code: 'not_entitled' | 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface AuthenticatedKey {
  id: string;
  workspaceId: string;
  scopes: ApiScope[];
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Token bucket per key: `API_RATE_LIMIT_PER_MINUTE` tokens, refilled continuously. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(
    private readonly capacity = API_RATE_LIMIT_PER_MINUTE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  take(key: string): { allowed: boolean; remaining: number; resetInSeconds: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    const refill = ((t - b.updatedAt) / 60_000) * this.capacity;
    b.tokens = Math.min(this.capacity, b.tokens + refill);
    b.updatedAt = t;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    const resetInSeconds = Math.ceil(((1 - Math.min(1, b.tokens)) * 60_000) / this.capacity / 1000);
    return {
      allowed,
      remaining: Math.floor(b.tokens),
      resetInSeconds: Math.max(1, resetInSeconds),
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export interface ApiKeyServiceDeps {
  db: Db;
  clock: Clock;
  billing?: BillingService;
}

export class ApiKeyService {
  readonly limiter = new RateLimiter();
  constructor(private readonly deps: ApiKeyServiceDeps) {}

  async list(ctx: TenantContext): Promise<ApiKeyDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(apiKey)
        .where(eq(apiKey.workspaceId, ctx.workspaceId))
        .orderBy(desc(apiKey.createdAt)),
    );
    return rows.map(toDto);
  }

  /** Returns the secret exactly once. */
  async create(
    ctx: TenantContext,
    input: { name: string; scopes: ApiScope[]; expiresAt?: Date | null },
  ): Promise<{ key: ApiKeyDto; secret: string }> {
    await this.assertEntitled(ctx.workspaceId);
    const name = input.name.trim().slice(0, 80);
    if (name.length === 0) throw new ApiKeyError('invalid', 'A name is required.');
    const scopes = [...new Set(input.scopes)].filter((s): s is ApiScope => API_SCOPES.includes(s));
    if (scopes.length === 0) throw new ApiKeyError('invalid', 'At least one scope is required.');
    const secret = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = uuidv7();
    const userId = ctx.actor.type === 'user' ? ctx.actor.id : null;
    const [row] = await this.deps.db
      .insert(apiKey)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        name,
        prefix: secret.slice(0, 12),
        keyHash: hashApiKey(secret),
        scopes,
        createdByUserId: userId,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'api_key',
      entityId: id,
      event: 'api_key.created',
      correlationId: ctx.correlationId,
      data: { name, scopes, prefix: secret.slice(0, 12) },
    });
    return { key: toDto(row!), secret };
  }

  async revoke(ctx: TenantContext, id: string): Promise<void> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .update(apiKey)
        .set({ revokedAt: this.deps.clock.now() })
        .where(
          and(eq(apiKey.workspaceId, ctx.workspaceId), eq(apiKey.id, id), isNull(apiKey.revokedAt)),
        )
        .returning({ id: apiKey.id }),
    );
    if (rows.length === 0) throw new ApiKeyError('not_found', 'API key not found.');
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'api_key',
      entityId: id,
      event: 'api_key.revoked',
      correlationId: ctx.correlationId,
    });
  }

  /** Null for unknown, revoked or expired keys. Touches `last_used_at` at most once a minute. */
  async authenticate(secret: string): Promise<AuthenticatedKey | null> {
    if (!secret.startsWith(API_KEY_PREFIX)) return null;
    const [row] = await this.deps.db
      .select()
      .from(apiKey)
      .where(eq(apiKey.keyHash, hashApiKey(secret)))
      .limit(1);
    const now = this.deps.clock.now();
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < now.getTime()))
      return null;
    if (
      this.deps.billing &&
      !planHas(await this.deps.billing.planFor(row.workspaceId), 'publicApi')
    )
      return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      await this.deps.db.update(apiKey).set({ lastUsedAt: now }).where(eq(apiKey.id, row.id));
    }
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      scopes: row.scopes.filter((s): s is ApiScope => API_SCOPES.includes(s as ApiScope)),
    };
  }

  // --- Idempotency -----------------------------------------------------------

  async findIdempotent(
    workspaceId: string,
    key: string,
  ): Promise<{ requestHash: string; status: number; body: unknown } | null> {
    const [row] = await this.deps.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.workspaceId, workspaceId), eq(idempotencyKey.key, key)))
      .limit(1);
    if (!row) return null;
    if (this.deps.clock.now().getTime() - row.createdAt.getTime() > IDEMPOTENCY_TTL_MS) return null;
    return { requestHash: row.requestHash, status: row.responseStatus, body: row.responseBody };
  }

  async storeIdempotent(input: {
    workspaceId: string;
    key: string;
    requestHash: string;
    method: string;
    path: string;
    status: number;
    body: unknown;
  }): Promise<void> {
    await this.deps.db
      .insert(idempotencyKey)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        key: input.key,
        requestHash: input.requestHash,
        method: input.method,
        path: input.path,
        responseStatus: input.status,
        responseBody: input.body ?? null,
        createdAt: this.deps.clock.now(),
      })
      .onConflictDoNothing();
  }

  /** Maintenance: expired replay records. */
  async pruneIdempotency(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - IDEMPOTENCY_TTL_MS);
    const rows = await this.deps.db
      .delete(idempotencyKey)
      .where(lt(idempotencyKey.createdAt, cutoff))
      .returning({ id: idempotencyKey.id });
    return rows.length;
  }

  private async assertEntitled(workspaceId: string): Promise<void> {
    if (!this.deps.billing) return;
    if (!planHas(await this.deps.billing.planFor(workspaceId), 'publicApi'))
      throw new ApiKeyError('not_entitled', 'The public API needs the Team plan or higher.');
  }
}

function toDto(k: ApiKey): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes.filter((s): s is ApiScope => API_SCOPES.includes(s as ApiScope)),
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt,
  };
}

export function requestHashOf(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}
