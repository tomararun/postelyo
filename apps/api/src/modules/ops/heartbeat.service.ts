import { lt, max } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import { workerHeartbeat } from '../../infra/db/schema.js';
import type { Clock } from '../../shared/clock.js';

/** Worker liveness (architecture §19): the api alerts when no worker has reported recently. */
export class HeartbeatService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async beat(instanceId: string, startedAt: Date, version: string | null): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insert(workerHeartbeat)
      .values({ instanceId, startedAt, lastSeenAt: now, version })
      .onConflictDoUpdate({
        target: workerHeartbeat.instanceId,
        set: { lastSeenAt: now, version },
      });
  }

  /** Seconds since the most recent heartbeat from any worker; null when none has ever reported. */
  async latestAgeSeconds(): Promise<number | null> {
    const [row] = await this.db
      .select({ latest: max(workerHeartbeat.lastSeenAt) })
      .from(workerHeartbeat);
    if (!row?.latest) return null;
    return Math.max(
      0,
      Math.floor((this.clock.now().getTime() - new Date(row.latest).getTime()) / 1000),
    );
  }

  async prune(olderThanMs = 24 * 60 * 60_000): Promise<void> {
    await this.db
      .delete(workerHeartbeat)
      .where(lt(workerHeartbeat.lastSeenAt, new Date(this.clock.now().getTime() - olderThanMs)));
  }
}
