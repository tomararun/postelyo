import { and, count, desc, eq, gte, sum } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  aiGeneration,
  workspace,
  type AiGeneration,
  type Workspace,
} from '../../infra/db/schema.js';
import { withTenantScope } from '../../infra/db/tenant-scope.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { uuidv7 } from '../../shared/ids.js';
import { recordAudit } from '../audit/audit.js';
import type { BillingService } from '../billing/billing.service.js';
import { PLANS, monthStart } from '../billing/plans.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { readSettings, type AiSettings } from '../workspaces/settings.js';
import {
  AiProviderError,
  costUsd,
  type AiProvider,
  type AiPurpose,
  type AiRequest,
} from './provider.js';

/**
 * Phase 6 AI service: the only path to the provider. Checks the workspace flag
 * and plan entitlement, enforces the monthly token budget, applies the
 * banned-phrase guardrail, and records every request in `ai_generation`
 * (prompt text, tokens, cost, outcome; never credentials).
 */

export class AiError extends Error {
  constructor(
    public readonly code: 'disabled' | 'not_entitled' | 'budget' | 'guardrail' | 'provider',
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiUsage {
  enabled: boolean;
  entitled: boolean;
  model: string;
  provider: string;
  budgetTokens: number;
  usedTokens: number;
  costUsd: number;
  generations: number;
  monthStart: Date;
}

export interface AiServiceDeps {
  db: Db;
  provider: AiProvider | null;
  billing: BillingService;
  clock: Clock;
  logger: Logger;
}

export const MAX_PROMPT_CHARS = 60_000;

export class AiService {
  constructor(private readonly deps: AiServiceDeps) {}

  get configured(): boolean {
    return this.deps.provider !== null;
  }

  settingsOf(ws: Pick<Workspace, 'settings'>): AiSettings {
    return readSettings(ws).ai ?? { enabled: false };
  }

  /** Plan entitlement in tokens per month (0 = none). */
  async budgetFor(workspaceId: string, ws: Pick<Workspace, 'settings'>): Promise<number> {
    const plan = await this.deps.billing.planFor(workspaceId);
    const planBudget = PLANS[plan].limits.aiTokensPerMonth;
    const override = this.settingsOf(ws).monthlyTokenBudget;
    return override !== undefined ? Math.min(override, planBudget) : planBudget;
  }

  async usedTokens(workspaceId: string): Promise<{ tokens: number; count: number }> {
    const since = monthStart(this.deps.clock.now());
    const [row] = await this.deps.db
      .select({ tokens: sum(aiGeneration.totalTokens), count: count() })
      .from(aiGeneration)
      .where(and(eq(aiGeneration.workspaceId, workspaceId), gte(aiGeneration.createdAt, since)));
    return { tokens: Number(row?.tokens ?? 0), count: Number(row?.count ?? 0) };
  }

  async usage(ctx: TenantContext): Promise<AiUsage> {
    const [ws] = await this.deps.db
      .select()
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId))
      .limit(1);
    if (!ws) throw new Error('workspace not found');
    const settings = this.settingsOf(ws);
    const budget = await this.budgetFor(ctx.workspaceId, ws);
    const since = monthStart(this.deps.clock.now());
    const rows = await withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select({ tokens: aiGeneration.totalTokens, cost: aiGeneration.costUsd })
        .from(aiGeneration)
        .where(
          and(eq(aiGeneration.workspaceId, ctx.workspaceId), gte(aiGeneration.createdAt, since)),
        ),
    );
    return {
      enabled: settings.enabled && this.configured,
      entitled: budget > 0,
      model: settings.model ?? this.deps.provider?.model ?? 'none',
      provider: this.deps.provider?.id ?? 'none',
      budgetTokens: budget,
      usedTokens: rows.reduce((n, r) => n + r.tokens, 0),
      costUsd: rows.reduce((n, r) => n + Number(r.cost), 0),
      generations: rows.length,
      monthStart: since,
    };
  }

  async recent(ctx: TenantContext, limit = 50): Promise<AiGeneration[]> {
    return withTenantScope(this.deps.db, ctx.workspaceId, (tx) =>
      tx
        .select()
        .from(aiGeneration)
        .where(eq(aiGeneration.workspaceId, ctx.workspaceId))
        .orderBy(desc(aiGeneration.createdAt))
        .limit(limit),
    );
  }

  /** True when the workspace may generate right now (flag, entitlement, budget). Never throws. */
  async available(workspaceId: string, ws: Pick<Workspace, 'settings'>): Promise<boolean> {
    try {
      await this.assertAvailable(workspaceId, ws);
      return true;
    } catch {
      return false;
    }
  }

  async assertAvailable(workspaceId: string, ws: Pick<Workspace, 'settings'>): Promise<void> {
    if (!this.deps.provider)
      throw new AiError('disabled', 'AI assistance is not configured on this server.');
    if (!this.settingsOf(ws).enabled)
      throw new AiError('disabled', 'AI assistance is off for this workspace.');
    const budget = await this.budgetFor(workspaceId, ws);
    if (budget <= 0)
      throw new AiError('not_entitled', 'The current plan does not include AI assistance.');
    const used = await this.usedTokens(workspaceId);
    if (used.tokens >= budget) {
      throw new AiError(
        'budget',
        `The monthly AI budget (${budget.toLocaleString('en-US')} tokens) is used up; it resets next month.`,
      );
    }
  }

  /**
   * One generation: checks, provider call, guardrail, audit row. Returns the
   * text. Throws `AiError`; the caller decides how to surface it.
   */
  async generate(
    ctx: TenantContext,
    ws: Pick<Workspace, 'id' | 'settings'>,
    req: Omit<AiRequest, 'correlationId'> & { entityType?: string; entityId?: string },
  ): Promise<{ text: string; generationId: string }> {
    await this.assertAvailable(ctx.workspaceId, ws);
    const provider = this.deps.provider!;
    const settings = this.settingsOf(ws);
    const system = [req.system, voiceBlock(settings)].filter((s) => s.length > 0).join('\n\n');
    const prompt =
      req.prompt.length > MAX_PROMPT_CHARS ? req.prompt.slice(0, MAX_PROMPT_CHARS) : req.prompt;
    const id = uuidv7();
    const now = this.deps.clock.now();
    let outcome: 'ok' | 'guardrail' | 'error' = 'ok';
    let error: string | null = null;
    let text = '';
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: provider.model,
      durationMs: 0,
    };
    try {
      const r = await provider.generate({
        ...req,
        system,
        prompt,
        correlationId: ctx.correlationId,
      });
      usage = r;
      text = r.text;
      const banned = bannedPhraseHit(text, settings.bannedPhrases ?? []);
      if (banned) {
        outcome = 'guardrail';
        error = `Output contained the banned phrase "${banned}" and was discarded.`;
      }
    } catch (err) {
      outcome = 'error';
      error =
        err instanceof AiProviderError ? err.message : `unexpected: ${(err as Error).message}`;
      if (!(err instanceof AiProviderError)) this.deps.logger.error({ err }, 'ai provider crashed');
    }
    const cost = costUsd(usage.model, usage);
    await this.deps.db.insert(aiGeneration).values({
      id,
      workspaceId: ctx.workspaceId,
      purpose: req.purpose,
      provider: provider.id,
      model: usage.model,
      entityType: req.entityType ?? null,
      entityId: req.entityId ?? null,
      promptText: `${system}\n\n---\n\n${prompt}`.slice(0, 20_000),
      outputText: text.slice(0, 20_000),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      costUsd: cost.toFixed(6),
      durationMs: usage.durationMs,
      outcome,
      error,
      createdByActor: `${ctx.actor.type}:${ctx.actor.id}`,
      createdAt: now,
    });
    await recordAudit(this.deps.db, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      entityType: 'ai_generation',
      entityId: id,
      event: 'ai.generated',
      correlationId: ctx.correlationId,
      data: {
        purpose: req.purpose,
        model: usage.model,
        tokens: usage.inputTokens + usage.outputTokens,
        costUsd: cost,
        outcome,
        ...(req.entityId ? { entityType: req.entityType, entityId: req.entityId } : {}),
      },
    });
    if (outcome === 'guardrail') throw new AiError('guardrail', error!);
    if (outcome === 'error') throw new AiError('provider', error!);
    return { text, generationId: id };
  }
}

export function voiceBlock(settings: AiSettings): string {
  const parts: string[] = [];
  if (settings.voice?.trim()) parts.push(`BRAND VOICE (follow closely):\n${settings.voice.trim()}`);
  if (settings.bannedPhrases && settings.bannedPhrases.length > 0)
    parts.push(
      `NEVER use these phrases: ${settings.bannedPhrases.map((p) => `"${p}"`).join(', ')}.`,
    );
  return parts.join('\n\n');
}

export function bannedPhraseHit(text: string, phrases: string[]): string | null {
  const lower = text.toLowerCase();
  for (const p of phrases) {
    const needle = p.trim().toLowerCase();
    if (needle.length > 0 && lower.includes(needle)) return p;
  }
  return null;
}

export type { AiPurpose };
