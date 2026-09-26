import { eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { socialAccount, user, workspace } from '../../infra/db/schema.js';
import { readSettings } from '../workspaces/settings.js';

export interface AccountAdmin {
  email: string;
  name: string;
  workspaceName: string;
  accountName: string;
}

/**
 * Resolves who receives which notification (architecture §10.4, P5/P9).
 * Operational alerts → the platform-level alert address, plus an optional
 * per-workspace copy (Phase 3 `alertCopyEmail`). Account notices → the
 * workspace's `notificationEmail` when set, otherwise the admin who
 * connected the account. The two kinds are never merged.
 */
export class NotificationTargets {
  constructor(
    private readonly db: Db,
    private readonly alertEmail: string | null,
  ) {}

  alertRecipient(): string | null {
    return this.alertEmail;
  }

  /** Optional per-workspace copy of operational alerts. */
  async alertCopyFor(workspaceId: string | null): Promise<string | null> {
    if (!workspaceId) return null;
    const [ws] = await this.db
      .select({ settings: workspace.settings })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1);
    return ws ? (readSettings(ws).alertCopyEmail ?? null) : null;
  }

  async accountAdmin(accountId: string): Promise<AccountAdmin | null> {
    const [row] = await this.db
      .select({
        email: user.email,
        name: user.name,
        workspaceName: workspace.name,
        workspaceSettings: workspace.settings,
        accountName: socialAccount.displayName,
      })
      .from(socialAccount)
      .innerJoin(workspace, eq(workspace.id, socialAccount.workspaceId))
      .innerJoin(user, eq(user.id, socialAccount.connectedByUserId))
      .where(eq(socialAccount.id, accountId))
      .limit(1);
    if (!row) return null;
    const override = readSettings({ settings: row.workspaceSettings }).notificationEmail;
    return {
      email: override ?? row.email,
      name: override ? 'team' : row.name,
      workspaceName: row.workspaceName,
      accountName: row.accountName,
    };
  }
}
