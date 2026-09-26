import { and, count, eq, gt, inArray, or } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { publication } from '../../infra/db/schema.js';

/** Rolling window the per-account cap applies to. */
export const CAP_WINDOW_MS = 24 * 60 * 60_000;

export interface AccountUsage {
  /** Published within the window plus in-flight rows that will count once they succeed. */
  used: number;
  /** When the oldest publication in the window leaves it; null when nothing is in the window. */
  nextFreeAt: Date | null;
}

type Reader = Pick<Db, 'select'>;

/**
 * Posts an account made (or is about to make) in the rolling window. In-flight
 * rows count so a burst of due publications cannot all pass the check before
 * any of them is published (architecture §4 item 5, Phase 1 daily caps).
 */
export async function accountUsage(
  db: Reader,
  socialAccountId: string,
  now: Date,
): Promise<AccountUsage> {
  const windowStart = new Date(now.getTime() - CAP_WINDOW_MS);
  const [row] = await db
    .select({ n: count() })
    .from(publication)
    .where(
      and(
        eq(publication.socialAccountId, socialAccountId),
        or(
          and(eq(publication.state, 'published'), gt(publication.publishedAt, windowStart)),
          inArray(publication.state, ['queued', 'publishing', 'retry_wait']),
        ),
      ),
    );
  const [oldest] = await db
    .select({ publishedAt: publication.publishedAt })
    .from(publication)
    .where(
      and(
        eq(publication.socialAccountId, socialAccountId),
        eq(publication.state, 'published'),
        gt(publication.publishedAt, windowStart),
      ),
    )
    .orderBy(publication.publishedAt)
    .limit(1);
  return {
    used: row?.n ?? 0,
    nextFreeAt: oldest?.publishedAt ? new Date(oldest.publishedAt.getTime() + CAP_WINDOW_MS) : null,
  };
}
