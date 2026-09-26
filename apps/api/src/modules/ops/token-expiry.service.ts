import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { socialAccount } from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Mailer } from '../../infra/mailer.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import {
  blockAccountPublications,
  markAccountNeedsReauth,
} from '../connections/account-blocking.js';
import {
  needsReauthEmail,
  tokenExpiredEmail,
  tokenExpiringEmail,
} from '../notifications/emails.js';
import type { NotificationTargets } from '../notifications/targets.js';
import { systemContext } from '../tenancy/tenant-context.js';

export const REMINDER_LEAD_MS = 7 * 24 * 60 * 60_000;

export interface TokenExpiryDeps {
  db: Db;
  mailer: Mailer;
  targets: NotificationTargets;
  clock: Clock;
  logger: Logger;
  appBaseUrl: string;
}

export interface TokenExpirySummary {
  reminders: number;
  expired: number;
  reauthNotices: number;
}

/**
 * Token lifecycle notices to the connecting admin (architecture §6.3, P9):
 * a reminder 7 days before expiry, a notice when the token expires (account
 * marked, publications blocked) and a notice when publishing hit an auth error.
 */
export class TokenExpiryService {
  constructor(private readonly deps: TokenExpiryDeps) {}

  async run(correlationId: string): Promise<TokenExpirySummary> {
    const summary: TokenExpirySummary = { reminders: 0, expired: 0, reauthNotices: 0 };
    const now = this.deps.clock.now();
    const link = (wsId: string) => `${this.deps.appBaseUrl}/w/${wsId}/connections`;

    // 1. Expired tokens on active accounts.
    const expired = await this.deps.db
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.status, 'active'),
          isNull(socialAccount.disconnectedAt),
          lt(socialAccount.tokenExpiresAt, now),
        ),
      );
    for (const acc of expired) {
      const ctx = systemContext(acc.workspaceId, 'token-expiry', correlationId);
      const blockedCount = await this.deps.db.transaction(async (tx) => {
        await markAccountNeedsReauth(tx, ctx, acc.id, 'token_expired', now);
        const blocked = await blockAccountPublications(tx, ctx, acc.id, 'token_expired', now);
        return blocked.length;
      });
      const admin = await this.deps.targets.accountAdmin(acc.id);
      if (admin) {
        await this.deps.mailer.send({
          to: admin.email,
          ...tokenExpiredEmail({
            accountName: admin.accountName,
            workspaceName: admin.workspaceName,
            blockedCount,
            link: link(acc.workspaceId),
          }),
        });
        await this.recordNotice(acc, 'token_expired', correlationId);
      }
      await this.deps.db
        .update(socialAccount)
        .set({ reauthNotifiedAt: now, updatedAt: now })
        .where(eq(socialAccount.id, acc.id));
      summary.expired += 1;
    }

    // 2. Reminders for tokens expiring within the lead time.
    const soon = await this.deps.db
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.status, 'active'),
          isNull(socialAccount.disconnectedAt),
          isNull(socialAccount.reauthReminderSentAt),
          lt(socialAccount.tokenExpiresAt, new Date(now.getTime() + REMINDER_LEAD_MS)),
        ),
      );
    for (const acc of soon) {
      const admin = await this.deps.targets.accountAdmin(acc.id);
      if (admin && acc.tokenExpiresAt) {
        await this.deps.mailer.send({
          to: admin.email,
          ...tokenExpiringEmail({
            accountName: admin.accountName,
            workspaceName: admin.workspaceName,
            expiresAt: acc.tokenExpiresAt,
            link: link(acc.workspaceId),
          }),
        });
        await this.recordNotice(acc, 'token_expiring', correlationId);
      }
      await this.deps.db
        .update(socialAccount)
        .set({ reauthReminderSentAt: now, updatedAt: now })
        .where(eq(socialAccount.id, acc.id));
      summary.reminders += 1;
    }

    // 3. Accounts that need re-authorization (e.g. auth error while publishing) and were not told yet.
    const needs = await this.deps.db
      .select()
      .from(socialAccount)
      .where(
        and(
          eq(socialAccount.status, 'needs_reauth'),
          isNull(socialAccount.disconnectedAt),
          isNull(socialAccount.reauthNotifiedAt),
        ),
      );
    for (const acc of needs) {
      const admin = await this.deps.targets.accountAdmin(acc.id);
      if (admin) {
        await this.deps.mailer.send({
          to: admin.email,
          ...needsReauthEmail({
            accountName: admin.accountName,
            workspaceName: admin.workspaceName,
            link: link(acc.workspaceId),
          }),
        });
        await this.recordNotice(acc, 'needs_reauth', correlationId);
      }
      await this.deps.db
        .update(socialAccount)
        .set({ reauthNotifiedAt: now, updatedAt: now })
        .where(eq(socialAccount.id, acc.id));
      summary.reauthNotices += 1;
    }
    return summary;
  }

  private async recordNotice(
    acc: { id: string; workspaceId: string },
    type: string,
    correlationId: string,
  ): Promise<void> {
    await recordAudit(this.deps.db, {
      workspaceId: acc.workspaceId,
      actor: { type: 'system', id: 'token-expiry' },
      entityType: 'social_account',
      entityId: acc.id,
      event: 'notification.sent',
      correlationId,
      data: { type, recipientKind: 'connecting_admin' },
    });
  }
}
