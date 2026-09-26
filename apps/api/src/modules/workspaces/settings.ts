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

/** Providers that can be switched on per workspace (Phase 2). LinkedIn is always on. */
export const FLAGGED_PROVIDERS = ['x', 'facebook', 'instagram'] as const;
export type FlaggedProvider = (typeof FLAGGED_PROVIDERS)[number];

export interface WorkspaceSettings {
  v: 1;
  /** Posts per social account per rolling 24 h; `undefined` = default. */
  dailyCapPerAccount?: number;
  /** Process inbound Notion webhooks for this workspace (polling stays authoritative). */
  notionWebhooks?: boolean;
  /** Per-workspace platform flags; a platform is usable only when the server has app credentials too. */
  providers?: Partial<Record<FlaggedProvider, boolean>>;
  /** Phase 3: receives account notices (token expiry, re-auth) instead of the connecting admin. */
  notificationEmail?: string;
  /** Phase 3: gets a copy of operational alerts that concern this workspace. */
  alertCopyEmail?: string;
}

export function readSettings(ws: Pick<Workspace, 'settings'>): WorkspaceSettings {
  const raw = (ws.settings ?? {}) as Partial<WorkspaceSettings>;
  const out: WorkspaceSettings = { v: 1 };
  if (typeof raw.dailyCapPerAccount === 'number' && Number.isFinite(raw.dailyCapPerAccount)) {
    out.dailyCapPerAccount = raw.dailyCapPerAccount;
  }
  if (typeof raw.notionWebhooks === 'boolean') out.notionWebhooks = raw.notionWebhooks;
  if (typeof raw.providers === 'object' && raw.providers !== null) {
    const providers: Partial<Record<FlaggedProvider, boolean>> = {};
    for (const p of FLAGGED_PROVIDERS) {
      const v = (raw.providers as Record<string, unknown>)[p];
      if (typeof v === 'boolean') providers[p] = v;
    }
    out.providers = providers;
  }
  if (typeof raw.notificationEmail === 'string' && raw.notificationEmail.includes('@')) {
    out.notificationEmail = raw.notificationEmail;
  }
  if (typeof raw.alertCopyEmail === 'string' && raw.alertCopyEmail.includes('@')) {
    out.alertCopyEmail = raw.alertCopyEmail;
  }
  return out;
}

export function dailyCapFor(ws: Pick<Workspace, 'settings'>): number {
  return readSettings(ws).dailyCapPerAccount ?? DEFAULT_DAILY_CAP_PER_ACCOUNT;
}

export function notionWebhooksEnabled(ws: Pick<Workspace, 'settings'>): boolean {
  return readSettings(ws).notionWebhooks === true;
}

/** LinkedIn is always enabled; the others need the workspace flag. */
export function providerEnabled(ws: Pick<Workspace, 'settings'>, provider: string): boolean {
  if (provider === 'linkedin' || provider === 'fake') return true;
  const flags = readSettings(ws).providers ?? {};
  return flags[provider as FlaggedProvider] === true;
}
