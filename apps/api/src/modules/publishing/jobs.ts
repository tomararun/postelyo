/**
 * Job enqueue boundary between the domain (scheduler, engine, webhooks) and the
 * queue implementation (pg-boss in the worker, an in-memory recorder in tests).
 */

export interface PublishJobData {
  publicationId: string;
  cycleNo: number;
}

export interface WritebackJobData {
  publicationId: string;
}

/** Single-page Notion sync triggered by a webhook (architecture §11.1). */
export interface SyncPageJobData {
  workspaceId: string;
  sourceId: string;
  pageId: string;
}

export interface JobEnqueuer {
  /** Idempotent per publication: a job already created or active is not duplicated. */
  publish(data: PublishJobData, opts?: { startAfter?: Date }): Promise<void>;
  writeback(data: WritebackJobData): Promise<void>;
  /** Idempotent per page: a burst of webhook events collapses into one sync. */
  syncPage(data: SyncPageJobData): Promise<void>;
}

/** Test double that records what would have been enqueued. */
export class RecordingEnqueuer implements JobEnqueuer {
  readonly published: { data: PublishJobData; startAfter?: Date }[] = [];
  readonly writebacks: WritebackJobData[] = [];
  readonly syncPages: SyncPageJobData[] = [];

  async publish(data: PublishJobData, opts?: { startAfter?: Date }): Promise<void> {
    this.published.push(opts?.startAfter ? { data, startAfter: opts.startAfter } : { data });
  }

  async writeback(data: WritebackJobData): Promise<void> {
    this.writebacks.push(data);
  }

  async syncPage(data: SyncPageJobData): Promise<void> {
    this.syncPages.push(data);
  }

  reset(): void {
    this.published.length = 0;
    this.writebacks.length = 0;
    this.syncPages.length = 0;
  }
}
