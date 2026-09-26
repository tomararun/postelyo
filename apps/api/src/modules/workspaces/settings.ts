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
  /** Phase 4: link handling applied at render time (never to the Notion source). */
  links?: LinkSettings;
  /** Phase 4: evergreen re-share slots. */
  evergreen?: EvergreenSettings;
  /** Phase 4: opt-in approval enforcement. */
  approval?: ApprovalSettings;
  /** Phase 6: AI assistance flag, voice and guardrails. */
  ai?: AiSettings;
}

export interface AiSettings {
  enabled: boolean;
  /** Model override (server default otherwise). */
  model?: string | undefined;
  /** Brand voice document injected into every prompt. */
  voice?: string | undefined;
  bannedPhrases?: string[] | undefined;
  /** Lower than the plan entitlement only. */
  monthlyTokenBudget?: number | undefined;
}

export interface UtmSettings {
  source?: string | undefined;
  medium?: string | undefined;
  /** May contain `{campaign}` (campaign name slug) and `{platform}`. */
  campaign?: string | undefined;
}

export interface LinkSettings {
  utm?: UtmSettings | undefined;
  /** Replace links with `${APP_BASE_URL}/l/<code>` and count clicks. */
  shorten?: boolean | undefined;
}

export interface EvergreenSlot {
  /** 1 = Monday … 7 = Sunday (ISO). */
  weekday: number;
  /** HH:MM in the workspace time zone. */
  time: string;
}

export interface EvergreenSettings {
  slots: EvergreenSlot[];
  /** Days before the same page may be re-shared to the same account (default 30). */
  minGapDays?: number | undefined;
}

export interface ApprovalSettings {
  required: boolean;
  /** User ids allowed to approve; owners always may. */
  reviewers: string[];
}

export const DEFAULT_EVERGREEN_MIN_GAP_DAYS = 30;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function readLinks(raw: unknown): LinkSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: LinkSettings = {};
  if (typeof r['utm'] === 'object' && r['utm'] !== null) {
    const u = r['utm'] as Record<string, unknown>;
    const utm: UtmSettings = {};
    for (const k of ['source', 'medium', 'campaign'] as const) {
      if (typeof u[k] === 'string' && u[k].trim().length > 0) utm[k] = u[k].trim();
    }
    if (Object.keys(utm).length > 0) out.utm = utm;
  }
  if (typeof r['shorten'] === 'boolean') out.shorten = r['shorten'];
  return Object.keys(out).length > 0 ? out : undefined;
}

function readEvergreen(raw: unknown): EvergreenSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const slots: EvergreenSlot[] = Array.isArray(r['slots'])
    ? r['slots']
        .map((s) => s as Record<string, unknown>)
        .filter(
          (s) =>
            typeof s['weekday'] === 'number' &&
            s['weekday'] >= 1 &&
            s['weekday'] <= 7 &&
            typeof s['time'] === 'string' &&
            TIME_RE.test(s['time']),
        )
        .map((s) => ({ weekday: s['weekday'] as number, time: s['time'] as string }))
    : [];
  const out: EvergreenSettings = { slots };
  if (typeof r['minGapDays'] === 'number' && r['minGapDays'] >= 1) out.minGapDays = r['minGapDays'];
  return out;
}

function readAi(raw: unknown): AiSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: AiSettings = { enabled: r['enabled'] === true };
  if (typeof r['model'] === 'string' && r['model'].trim()) out.model = r['model'].trim();
  if (typeof r['voice'] === 'string' && r['voice'].trim())
    out.voice = r['voice'].trim().slice(0, 4000);
  if (Array.isArray(r['bannedPhrases']))
    out.bannedPhrases = r['bannedPhrases']
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
      .slice(0, 100);
  if (typeof r['monthlyTokenBudget'] === 'number' && r['monthlyTokenBudget'] >= 0)
    out.monthlyTokenBudget = Math.floor(r['monthlyTokenBudget']);
  return out;
}

function readApproval(raw: unknown): ApprovalSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    required: r['required'] === true,
    reviewers: Array.isArray(r['reviewers'])
      ? r['reviewers'].filter((x): x is string => typeof x === 'string')
      : [],
  };
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
  const links = readLinks(raw.links);
  if (links) out.links = links;
  const evergreen = readEvergreen(raw.evergreen);
  if (evergreen) out.evergreen = evergreen;
  const approval = readApproval(raw.approval);
  if (approval) out.approval = approval;
  const ai = readAi(raw.ai);
  if (ai) out.ai = ai;
  return out;
}

export function approvalRequired(ws: Pick<Workspace, 'settings'>): boolean {
  return readSettings(ws).approval?.required === true;
}

/** Owners always may approve; otherwise the user must be listed as a reviewer. */
export function canApprove(ws: Pick<Workspace, 'settings'>, userId: string, role: string): boolean {
  if (role === 'owner') return true;
  return (readSettings(ws).approval?.reviewers ?? []).includes(userId);
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
