import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../../infra/db/client.js';
import { contentSource, webhookEvent, workspace } from '../../../infra/db/schema.js';
import type { Logger } from '../../../infra/logger.js';
import type { Clock } from '../../../shared/clock.js';
import { uuidv7 } from '../../../shared/ids.js';
import { recordAudit } from '../../audit/audit.js';
import type { JobEnqueuer } from '../../publishing/jobs.js';
import { notionWebhooksEnabled } from '../../workspaces/settings.js';
import { parseNotionDatabaseId } from './notion-schema.js';

/**
 * Inbound Notion integration webhooks (architecture §11.1). Verified, stored
 * idempotently, acknowledged fast; the actual work is a `notion-sync-page`
 * job. Polling stays authoritative: a lost or rejected webhook only costs
 * latency.
 *
 * Protocol (verify against Notion's current docs): the first delivery carries
 * `{ "verification_token": "…" }` and no signature; every later delivery is
 * signed with `X-Notion-Signature: sha256=<hex hmac of the raw body>` keyed by
 * that token.
 */

export const NOTION_SIGNATURE_HEADER = 'x-notion-signature';
/** Keep raw events this long for debugging; the audit log is the durable record. */
export const WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface NotionWebhookDeps {
  db: Db;
  enqueue: JobEnqueuer;
  clock: Clock;
  logger: Logger;
  /** The verification token Notion issued; null until the operator configured it. */
  secret: string | null;
}

export type WebhookReceipt =
  | { status: 200; body: { ok: true; outcome: string } }
  | { status: 202; body: { ok: true; outcome: 'verification_pending' } }
  | { status: 400 | 401 | 413; body: { ok: false; error: string } };

interface NotionEvent {
  id: string;
  type: string;
  timestamp?: string;
  entity?: { id?: string; type?: string };
  data?: { parent?: { id?: string; type?: string } };
}

export class NotionWebhookService {
  constructor(private readonly deps: NotionWebhookDeps) {}

  /** Constant-time signature check over the raw body. */
  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    if (!this.deps.secret || !header) return false;
    const expected = `sha256=${createHmac('sha256', this.deps.secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(header.trim());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async receive(
    rawBody: Buffer,
    signature: string | undefined,
    correlationId: string,
  ): Promise<WebhookReceipt> {
    if (rawBody.byteLength > MAX_PAYLOAD_BYTES) {
      return { status: 413, body: { ok: false, error: 'payload too large' } };
    }
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      json =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { status: 400, body: { ok: false, error: 'invalid json' } };
    }

    // Subscription bootstrap: Notion sends the token once; the operator copies it into
    // NOTION_WEBHOOK_SECRET. It is logged in full on purpose, only in this one place.
    if (typeof json['verification_token'] === 'string') {
      if (this.deps.secret) {
        this.deps.logger.warn(
          'notion webhook verification token received although NOTION_WEBHOOK_SECRET is set; ignoring',
        );
        return { status: 200, body: { ok: true, outcome: 'verification_ignored' } };
      }
      this.deps.logger.warn(
        { verificationToken: json['verification_token'] },
        'notion webhook verification token received: set NOTION_WEBHOOK_SECRET to this value and restart',
      );
      return { status: 202, body: { ok: true, outcome: 'verification_pending' } };
    }

    if (!this.verifySignature(rawBody, signature)) {
      return { status: 401, body: { ok: false, error: 'invalid signature' } };
    }

    const event = json as unknown as NotionEvent;
    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      return { status: 400, body: { ok: false, error: 'missing id or type' } };
    }
    const outcome = await this.store(event, json, correlationId);
    return { status: 200, body: { ok: true, outcome } };
  }

  /** Persists the event (idempotent) and enqueues a single-page sync when it maps to an active source. */
  private async store(
    event: NotionEvent,
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<string> {
    const now = this.deps.clock.now();
    const pageId = event.entity?.type === 'page' ? (event.entity.id ?? null) : null;
    const parentRaw = event.data?.parent?.type === 'database' ? event.data.parent.id : undefined;
    const databaseId = parentRaw ? parseNotionDatabaseId(parentRaw) : null;

    const id = uuidv7();
    const inserted = await this.deps.db
      .insert(webhookEvent)
      .values({
        id,
        workspaceId: null,
        source: 'notion',
        externalEventId: event.id,
        eventType: event.type,
        entityId: pageId,
        receivedAt: now,
        payload,
      })
      .onConflictDoNothing({ target: [webhookEvent.source, webhookEvent.externalEventId] })
      .returning({ id: webhookEvent.id });
    if (inserted.length === 0) return 'duplicate';

    let outcome: string;
    let workspaceId: string | null = null;
    if (!pageId || !databaseId) {
      outcome = 'ignored:not_a_database_page_event';
    } else {
      const sources = await this.deps.db
        .select({
          id: contentSource.id,
          workspaceId: contentSource.workspaceId,
          settings: workspace.settings,
        })
        .from(contentSource)
        .innerJoin(workspace, eq(workspace.id, contentSource.workspaceId))
        .where(
          and(
            eq(contentSource.kind, 'notion'),
            eq(contentSource.externalDatabaseId, databaseId),
            eq(contentSource.status, 'active'),
            isNull(contentSource.disconnectedAt),
          ),
        );
      if (sources.length === 0) {
        outcome = 'ignored:unknown_database';
      } else {
        let enqueued = 0;
        for (const s of sources) {
          workspaceId = s.workspaceId;
          if (!notionWebhooksEnabled({ settings: s.settings })) continue;
          await this.deps.enqueue.syncPage({
            workspaceId: s.workspaceId,
            sourceId: s.id,
            pageId,
          });
          enqueued += 1;
        }
        outcome = enqueued > 0 ? 'enqueued' : 'ignored:webhooks_disabled';
      }
    }

    await this.deps.db
      .update(webhookEvent)
      .set({ workspaceId, processedAt: now, outcome })
      .where(eq(webhookEvent.id, id));
    await recordAudit(this.deps.db, {
      workspaceId,
      actor: { type: 'webhook', id: 'notion' },
      entityType: 'webhook_event',
      entityId: id,
      event: 'webhook.received',
      correlationId,
      data: { source: 'notion', eventType: event.type, pageId, databaseId, outcome },
    });
    return outcome;
  }

  /** Housekeeping: drop raw events past retention. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - WEBHOOK_RETENTION_MS);
    const rows = await this.deps.db
      .delete(webhookEvent)
      .where(lt(webhookEvent.receivedAt, cutoff))
      .returning({ id: webhookEvent.id });
    return rows.length;
  }
}
