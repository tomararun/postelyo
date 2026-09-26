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

/** Phase 5: one metrics fetch for a publication (the tier is on the row). */
export interface MetricsJobData {
  publicationId: string;
}

/** Hard-delete of a soft-deleted workspace (Phase 3). */
export interface DeleteWorkspaceJobData {
  workspaceId: string;
}

export interface JobEnqueuer {
  /** Idempotent per publication: a job already created or active is not duplicated. */
  publish(data: PublishJobData, opts?: { startAfter?: Date }): Promise<void>;
  writeback(data: WritebackJobData): Promise<void>;
  /** Idempotent per page: a burst of webhook events collapses into one sync. */
  syncPage(data: SyncPageJobData): Promise<void>;
  deleteWorkspace(data: DeleteWorkspaceJobData): Promise<void>;
  /** Phase 5: separate queue; idempotent per publication (one pending fetch at a time). */
  fetchMetrics(data: MetricsJobData, opts?: { startAfter?: Date }): Promise<void>;
}

/** Test double that records what would have been enqueued. */
export class RecordingEnqueuer implements JobEnqueuer {
  readonly published: { data: PublishJobData; startAfter?: Date }[] = [];
  readonly writebacks: WritebackJobData[] = [];
  readonly syncPages: SyncPageJobData[] = [];
  readonly deletions: DeleteWorkspaceJobData[] = [];
  readonly metricFetches: { data: MetricsJobData; startAfter?: Date }[] = [];

  async fetchMetrics(data: MetricsJobData, opts?: { startAfter?: Date }): Promise<void> {
    this.metricFetches.push(opts?.startAfter ? { data, startAfter: opts.startAfter } : { data });
  }

  async deleteWorkspace(data: DeleteWorkspaceJobData): Promise<void> {
    this.deletions.push(data);
  }

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
    this.deletions.length = 0;
    this.metricFetches.length = 0;
  }
}
