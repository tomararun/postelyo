import type { Workspace } from '../../infra/db/schema.js';

/**
 * Workspace-level policies stored in `workspace.settings` (architecture §4 item 5,
 * roadmap Phase 1 "workspace-level policies"). Additive: unknown keys are kept.
 */

/**
 * Default posts per social account per rolling 24 h. LinkedIn documents 150
 * member posts per day per application; 100 leaves headroom for retries and
 * manual posts made outside Postelyo. Verify against current provider docs.
 */
export const DEFAULT_DAILY_CAP_PER_ACCOUNT = 100;
export const MAX_DAILY_CAP_PER_ACCOUNT = 1000;

export interface WorkspaceSettings {
  v: 1;
  /** Posts per social account per rolling 24 h; `undefined` = default. */
  dailyCapPerAccount?: number;
  /** Process inbound Notion webhooks for this workspace (polling stays authoritative). */
  notionWebhooks?: boolean;
}

export function readSettings(ws: Pick<Workspace, 'settings'>): WorkspaceSettings {
  const raw = (ws.settings ?? {}) as Partial<WorkspaceSettings>;
  const out: WorkspaceSettings = { v: 1 };
  if (typeof raw.dailyCapPerAccount === 'number' && Number.isFinite(raw.dailyCapPerAccount)) {
    out.dailyCapPerAccount = raw.dailyCapPerAccount;
  }
  if (typeof raw.notionWebhooks === 'boolean') out.notionWebhooks = raw.notionWebhooks;
  return out;
}

export function dailyCapFor(ws: Pick<Workspace, 'settings'>): number {
  return readSettings(ws).dailyCapPerAccount ?? DEFAULT_DAILY_CAP_PER_ACCOUNT;
}

export function notionWebhooksEnabled(ws: Pick<Workspace, 'settings'>): boolean {
  return readSettings(ws).notionWebhooks === true;
}
