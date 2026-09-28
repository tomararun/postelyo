import { createHmac, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  auditLog,
  webhookDelivery,
  webhookEndpoint,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit, type AuditEvent } from '../audit/audit.js';
import type { BillingService } from '../billing/billing.service.js';
import { planHas } from '../billing/plans.js';
import type { CredentialVault } from '../connections/credential-vault.js';
import type { AlertService } from '../ops/alerts.service.js';
import { systemContext, type TenantContext } from '../tenancy/tenant-context.js';

/**
 * Phase 7 outbound webhooks. Endpoints subscribe to audit events; a dispatcher
 * turns new audit rows into deliveries (per-endpoint cursor over the
 * time-ordered audit id), and a deliverer POSTs them with an HMAC signature,
 * retries with backoff up to eight attempts, and opens a circuit after ten
 * consecutive failures. Secrets are sealed like every other credential.
 */

/** Audit events customers may subscribe to. Everything else stays internal. */
export const DELIVERABLE_EVENTS: readonly AuditEvent[] = [
  'post.created',
  'post.state_changed',
  'post.archived',
  'post.validation_failed',
  'publication.created',
  'publication.state_changed',
  'publication.rescheduled',
  'publication.first_comment',
  'metrics.fetched',
  'approval.granted',
  'approval.revoked',
  'ai.generated',
  'campaign.summary_written',
  'social_account.connected',
  'social_account.disconnected',
  'social_account.status_changed',
  'content_source.sync_failed',
  'invitation.accepted',
  'membership.removed',
];

export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_CIRCUIT_FAILURES = 10;
/** Backoff after attempt n (1-based). */
export const WEBHOOK_BACKOFF_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export class WebhookError extends Error {
  constructor(
    public readonly code: 'not_entitled' | 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

export interface WebhookEndpointDto {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  consecutiveFailures: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  lastDeliveryAt: Date | null;
  lastStatusCode: number | null;
  createdAt: Date;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  event: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface WebhookServiceDeps {
  db: Db;
  vault: CredentialVault;
  clock: Clock;
  logger: Logger;
  billing?: BillingService;
  alerts?: AlertService;
  fetchImpl?: typeof fetch;
}

/** `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. */
export function signWebhook(secret: string, timestampSeconds: number, body: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts['t']);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const given = parts['v1'] ?? '';
  return given.length === expected.length && given === expected;
}

export class WebhookService {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly deps: WebhookServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  // --- Management ------------------------------------------------------------

  async list(ctx: TenantContext): Promise<WebhookEndpointDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(webhookEndpoint)
        .where(eq(webhookEndpoint.workspaceId, ctx.workspaceId))
        .orderBy(desc(webhookEndpoint.createdAt)),
    );
    return rows.map(toEndpointDto);
  }

  /** Returns the signing secret once. */
  async create(
    ctx: TenantContext,
    input: { url: string; description?: string | undefined; events?: string[] | undefined },
  ): Promise<{ endpoint: WebhookEndpointDto; secret: string }> {
    await this.assertEntitled(ctx.workspaceId);
    const url = validateUrl(input.url);
    const events = normaliseEvents(input.events ?? []);
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = uuidv7();
    // Start delivering from now: events before the subscription are not replayed.
    const [latest] = await this.deps.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, ctx.workspaceId))
      .orderBy(desc(auditLog.id))
      .limit(1);
    const [row] = await this.deps.db
      .insert(webhookEndpoint)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        url,
        description: input.description?.trim().slice(0, 200) || null,
        secretEnc: await this.deps.vault.sealFor(
          ctx.workspaceId,
          { entityType: 'webhook_endpoint', entityId: id, column: 'secret' },
          secret,
        ),
        events,
        cursorAuditId: latest?.id ?? null,
        createdByUserId: ctx.actor.type === 'user' ? ctx.actor.id : null,
      })
      .returning();
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'webhook_endpoint',
      entityId: id,
      event: 'webhook.endpoint_created',
      correlationId: ctx.correlationId,
      data: { url, events },
    });
    return { endpoint: toEndpointDto(row!), secret };
  }

  async update(
    ctx: TenantContext,
    id: string,
    patch: {
      url?: string | undefined;
      description?: string | null | undefined;
      events?: string[] | undefined;
      enabled?: boolean | undefined;
    },
  ): Promise<WebhookEndpointDto> {
    const set: Partial<typeof webhookEndpoint.$inferInsert> = { updatedAt: this.deps.clock.now() };
    if (patch.url !== undefined) set.url = validateUrl(patch.url);
    if (patch.description !== undefined)
      set.description = patch.description?.trim().slice(0, 200) || null;
    if (patch.events !== undefined) set.events = normaliseEvents(patch.events);
    if (patch.enabled !== undefined) {
      set.enabled = patch.enabled;
      if (patch.enabled) {
        set.consecutiveFailures = 0;
        set.disabledAt = null;
        set.disabledReason = null;
      }
    }
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .update(webhookEndpoint)
        .set(set)
        .where(and(eq(webhookEndpoint.workspaceId, ctx.workspaceId), eq(webhookEndpoint.id, id)))
        .returning(),
    );
    if (rows.length === 0) throw new WebhookError('not_found', 'Webhook endpoint not found.');
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'webhook_endpoint',
      entityId: id,
      event: 'webhook.endpoint_updated',
      correlationId: ctx.correlationId,
      data: { ...patch },
    });
    return toEndpointDto(rows[0]!);
  }

  async remove(ctx: TenantContext, id: string): Promise<void> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .delete(webhookEndpoint)
        .where(and(eq(webhookEndpoint.workspaceId, ctx.workspaceId), eq(webhookEndpoint.id, id)))
        .returning({ id: webhookEndpoint.id }),
    );
    if (rows.length === 0) throw new WebhookError('not_found', 'Webhook endpoint not found.');
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'webhook_endpoint',
      entityId: id,
      event: 'webhook.endpoint_deleted',
      correlationId: ctx.correlationId,
    });
  }

  async deliveries(
    ctx: TenantContext,
    endpointId?: string,
    limit = 50,
  ): Promise<WebhookDeliveryDto[]> {
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(webhookDelivery)
        .where(
          and(
            eq(webhookDelivery.workspaceId, ctx.workspaceId),
            ...(endpointId ? [eq(webhookDelivery.endpointId, endpointId)] : []),
          ),
        )
        .orderBy(desc(webhookDelivery.createdAt))
        .limit(limit),
    );
    return rows.map(toDeliveryDto);
  }

  /** Queues a `webhook.test` delivery and sends it right away. */
  async sendTest(ctx: TenantContext, id: string): Promise<WebhookDeliveryDto> {
    const [ep] = await this.deps.db
      .select()
      .from(webhookEndpoint)
      .where(and(eq(webhookEndpoint.workspaceId, ctx.workspaceId), eq(webhookEndpoint.id, id)))
      .limit(1);
    if (!ep) throw new WebhookError('not_found', 'Webhook endpoint not found.');
    const now = this.deps.clock.now();
    const deliveryId = uuidv7();
    await this.deps.db.insert(webhookDelivery).values({
      id: deliveryId,
      workspaceId: ctx.workspaceId,
      endpointId: ep.id,
      auditId: null,
      event: 'webhook.test',
      payload: {
        id: deliveryId,
        event: 'webhook.test',
        occurredAt: now.toISOString(),
        workspaceId: ctx.workspaceId,
        data: { message: 'Hello from Postelyo' },
      },
      nextAttemptAt: now,
      createdAt: now,
    });
    await this.deliverOne(deliveryId, ctx.correlationId);
    const [row] = await this.deps.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.id, deliveryId));
    return toDeliveryDto(row!);
  }

  // --- Dispatch and delivery --------------------------------------------------

  /** Turns audit rows newer than each endpoint's cursor into deliveries. */
  async dispatch(correlationId: string): Promise<{ endpoints: number; deliveries: number }> {
    const endpoints = await this.deps.db
      .select()
      .from(webhookEndpoint)
      .where(and(eq(webhookEndpoint.enabled, true), isNull(webhookEndpoint.disabledAt)));
    let created = 0;
    for (const ep of endpoints) {
      try {
        created += await this.dispatchEndpoint(ep);
      } catch (err) {
        this.deps.logger.warn({ err, endpointId: ep.id, correlationId }, 'webhook dispatch failed');
      }
    }
    return { endpoints: endpoints.length, deliveries: created };
  }

  private async dispatchEndpoint(ep: WebhookEndpoint): Promise<number> {
    const wanted = ep.events.length > 0 ? ep.events : [...DELIVERABLE_EVENTS];
    const rows = await this.deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, ep.workspaceId),
          inArray(auditLog.event, wanted),
          ...(ep.cursorAuditId ? [gt(auditLog.id, ep.cursorAuditId)] : []),
        ),
      )
      .orderBy(asc(auditLog.id))
      .limit(200);
    if (rows.length === 0) return 0;
    const now = this.deps.clock.now();
    await this.deps.db.insert(webhookDelivery).values(
      rows.map((a) => {
        const id = uuidv7();
        return {
          id,
          workspaceId: ep.workspaceId,
          endpointId: ep.id,
          auditId: a.id,
          event: a.event,
          payload: {
            id,
            event: a.event,
            occurredAt: a.occurredAt.toISOString(),
            workspaceId: a.workspaceId,
            entityType: a.entityType,
            entityId: a.entityId,
            fromState: a.fromState,
            toState: a.toState,
            actor: { type: a.actorType, id: a.actorId },
            data: a.data,
            auditId: a.id,
          },
          nextAttemptAt: now,
          createdAt: now,
        };
      }),
    );
    await this.deps.db
      .update(webhookEndpoint)
      .set({ cursorAuditId: rows.at(-1)!.id, updatedAt: now })
      .where(eq(webhookEndpoint.id, ep.id));
    return rows.length;
  }

  /** Sends every pending delivery whose time has come (bounded per run). */
  async deliverDue(
    correlationId: string,
    limit = 100,
  ): Promise<{ delivered: number; failed: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, 'pending'), lte(webhookDelivery.nextAttemptAt, now)))
      .orderBy(asc(webhookDelivery.nextAttemptAt))
      .limit(limit);
    let delivered = 0;
    let failed = 0;
    for (const d of due) {
      const ok = await this.deliverOne(d.id, correlationId);
      if (ok) delivered += 1;
      else failed += 1;
    }
    return { delivered, failed };
  }

  /** One attempt; returns true when the endpoint accepted it. */
  async deliverOne(deliveryId: string, correlationId: string): Promise<boolean> {
    const { db } = this.deps;
    const now = this.deps.clock.now();
    // Claim: only a pending, due delivery moves forward, once.
    const [d] = await db
      .update(webhookDelivery)
      .set({ nextAttemptAt: null, attempts: sql`${webhookDelivery.attempts} + 1` })
      .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.status, 'pending')))
      .returning();
    if (!d) return false;
    const [ep] = await db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, d.endpointId))
      .limit(1);
    if (!ep) {
      await db
        .update(webhookDelivery)
        .set({ status: 'dead', lastError: 'endpoint gone' })
        .where(eq(webhookDelivery.id, d.id));
      return false;
    }
    if (!ep.enabled || ep.disabledAt) {
      await db
        .update(webhookDelivery)
        .set({ status: 'dead', lastError: 'endpoint disabled' })
        .where(eq(webhookDelivery.id, d.id));
      return false;
    }
    const ctx = systemContext(ep.workspaceId, 'webhooks', correlationId);
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(now.getTime() / 1000);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const signature = await this.deps.vault.withCredential(
        ctx,
        { entityType: 'webhook_endpoint', entityId: ep.id, column: 'secret' },
        ep.secretEnc,
        'publish',
        async (secret) => signWebhook(secret, ts, body),
      );
      const res = await this.fetchImpl(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Postelyo-Webhooks/1',
          'x-postelyo-event': d.event,
          'x-postelyo-delivery': d.id,
          'x-postelyo-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      statusCode = res.status;
      if (!(res.status >= 200 && res.status < 300)) error = `HTTP ${res.status}`;
    } catch (err) {
      error =
        (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message.slice(0, 200);
    }
    const attempts = d.attempts;
    if (!error) {
      await db
        .update(webhookDelivery)
        .set({ status: 'delivered', deliveredAt: now, lastStatusCode: statusCode, lastError: null })
        .where(eq(webhookDelivery.id, d.id));
      await db
        .update(webhookEndpoint)
        .set({
          consecutiveFailures: 0,
          lastDeliveryAt: now,
          lastStatusCode: statusCode,
          updatedAt: now,
        })
        .where(eq(webhookEndpoint.id, ep.id));
      return true;
    }
    const dead = attempts >= WEBHOOK_MAX_ATTEMPTS;
    await db
      .update(webhookDelivery)
      .set({
        status: dead ? 'dead' : 'pending',
        nextAttemptAt: dead
          ? null
          : new Date(
              now.getTime() + (WEBHOOK_BACKOFF_MS[attempts - 1] ?? WEBHOOK_BACKOFF_MS.at(-1)!),
            ),
        lastStatusCode: statusCode,
        lastError: error,
      })
      .where(eq(webhookDelivery.id, d.id));
    const failures = ep.consecutiveFailures + 1;
    const trip = failures >= WEBHOOK_CIRCUIT_FAILURES;
    await db
      .update(webhookEndpoint)
      .set({
        consecutiveFailures: failures,
        lastDeliveryAt: now,
        lastStatusCode: statusCode,
        ...(trip
          ? {
              enabled: false,
              disabledAt: now,
              disabledReason: `${failures} consecutive failures (${error})`,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(webhookEndpoint.id, ep.id));
    if (trip) {
      await recordAudit(db, {
        workspaceId: ep.workspaceId,
        actor: ctx.actor,
        entityType: 'webhook_endpoint',
        entityId: ep.id,
        event: 'webhook.endpoint_disabled',
        correlationId,
        data: { failures, lastError: error, url: ep.url },
      });
      await this.deps.alerts
        ?.raise(
          'webhook.endpoint_disabled',
          ep.id,
          `Webhook endpoint ${ep.url} was disabled after ${failures} consecutive failures (${error}).`,
          ep.workspaceId,
          correlationId,
        )
        .catch(() => undefined);
    }
    return false;
  }

  private async assertEntitled(workspaceId: string): Promise<void> {
    if (!this.deps.billing) return;
    if (!planHas(await this.deps.billing.planFor(workspaceId), 'webhooks'))
      throw new WebhookError('not_entitled', 'Webhooks need the Team plan or higher.');
  }
}

function validateUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new WebhookError('invalid', 'The endpoint must be an https URL.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost'))
    throw new WebhookError('invalid', 'The endpoint must be an https URL.');
  return u.toString();
}

function normaliseEvents(events: string[]): string[] {
  const out = [...new Set(events.map((e) => e.trim()).filter((e) => e.length > 0))];
  const unknown = out.filter((e) => !DELIVERABLE_EVENTS.includes(e as AuditEvent));
  if (unknown.length > 0)
    throw new WebhookError('invalid', `Unknown events: ${unknown.join(', ')}`);
  return out;
}

function toEndpointDto(e: WebhookEndpoint): WebhookEndpointDto {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    consecutiveFailures: e.consecutiveFailures,
    disabledAt: e.disabledAt,
    disabledReason: e.disabledReason,
    lastDeliveryAt: e.lastDeliveryAt,
    lastStatusCode: e.lastStatusCode,
    createdAt: e.createdAt,
  };
}

function toDeliveryDto(d: WebhookDelivery): WebhookDeliveryDto {
  return {
    id: d.id,
    endpointId: d.endpointId,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  };
}
