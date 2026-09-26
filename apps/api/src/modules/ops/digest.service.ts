import { and, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { contentSource, publication, socialAccount, workspace } from '../../infra/db/schema.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import { digestEmail, type DigestRow } from '../notifications/emails.js';
import type { NotificationTargets } from '../notifications/targets.js';
import type { AlertService } from './alerts.service.js';

export interface DigestDeps {
  db: Db;
  mailer: Mailer;
  targets: NotificationTargets;
  alerts: AlertService;
  clock: Clock;
  environment: string;
}

/** Daily operator digest (architecture §10.4); suppression shares the alert window table. */
export class DigestService {
  constructor(private readonly deps: DigestDeps) {}

  async run(correlationId: string): Promise<'sent' | 'suppressed' | 'no_recipient'> {
    const to = this.deps.targets.alertRecipient();
    if (!to) return 'no_recipient';
    if (!(await this.deps.alerts.claim('ops.daily_digest', 'global', null, 'digest')))
      return 'suppressed';
    const rows = await this.collect();
    await this.deps.mailer.send({
      to,
      ...digestEmail({ environment: this.deps.environment, rows }),
    });
    await recordAudit(this.deps.db, {
      workspaceId: null,
      actor: { type: 'system', id: 'digest' },
      entityType: 'alert',
      entityId: 'ops.daily_digest',
      event: 'alert.sent',
      correlationId,
      data: { kind: 'ops.daily_digest', workspaces: rows.length },
    });
    return 'sent';
  }

  async collect(): Promise<DigestRow[]> {
    const { db } = this.deps;
    const since = new Date(this.deps.clock.now().getTime() - 24 * 60 * 60_000);
    const workspaces = await db
      .select({ id: workspace.id, name: workspace.name })
      .from(workspace)
      .where(isNull(workspace.deletedAt));
    const rows: DigestRow[] = [];
    for (const ws of workspaces) {
      const [failed] = await db
        .select({ n: count() })
        .from(publication)
        .where(and(eq(publication.workspaceId, ws.id), eq(publication.state, 'failed')));
      const [ambiguous] = await db
        .select({ n: count() })
        .from(publication)
        .where(and(eq(publication.workspaceId, ws.id), eq(publication.state, 'ambiguous')));
      const [published] = await db
        .select({ n: count() })
        .from(publication)
        .where(
          and(
            eq(publication.workspaceId, ws.id),
            eq(publication.state, 'published'),
            gt(publication.publishedAt, since),
          ),
        );
      const [needsReauth] = await db
        .select({ n: count() })
        .from(socialAccount)
        .where(
          and(
            eq(socialAccount.workspaceId, ws.id),
            eq(socialAccount.status, 'needs_reauth'),
            isNull(socialAccount.disconnectedAt),
          ),
        );
      const [sources] = await db
        .select({ n: count() })
        .from(contentSource)
        .where(
          and(
            eq(contentSource.workspaceId, ws.id),
            isNotNull(contentSource.lastError),
            isNull(contentSource.disconnectedAt),
          ),
        );
      rows.push({
        workspaceName: ws.name,
        failed: failed?.n ?? 0,
        ambiguous: ambiguous?.n ?? 0,
        publishedLast24h: published?.n ?? 0,
        needsReauth: needsReauth?.n ?? 0,
        sourcesInError: sources?.n ?? 0,
      });
    }
    return rows;
  }
}
