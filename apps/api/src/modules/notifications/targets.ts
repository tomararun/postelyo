import { eq } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { socialAccount, user, workspace } from '../../infra/db/schema.js';

export interface AccountAdmin {
  email: string;
  name: string;
  workspaceName: string;
  accountName: string;
}

/**
 * Resolves who receives which notification (architecture §10.4, P5/P9).
 * Operational alerts → the platform-level alert address. Account notices → the
 * admin who connected the account. The two are never merged by default. A
 * per-workspace override slot is reserved here for later.
 */
export class NotificationTargets {
  constructor(
    private readonly db: Db,
    private readonly alertEmail: string | null,
  ) {}

  alertRecipient(): string | null {
    return this.alertEmail;
  }

  async accountAdmin(accountId: string): Promise<AccountAdmin | null> {
    const [row] = await this.db
      .select({
        email: user.email,
        name: user.name,
        workspaceName: workspace.name,
        accountName: socialAccount.displayName,
      })
      .from(socialAccount)
      .innerJoin(workspace, eq(workspace.id, socialAccount.workspaceId))
      .innerJoin(user, eq(user.id, socialAccount.connectedByUserId))
      .where(eq(socialAccount.id, accountId))
      .limit(1);
    return row ?? null;
  }
}
