import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../infra/db/client.js';
import {
  post,
  publication,
  publishAttempt,
  socialAccount,
  type Publication,
} from '../../infra/db/schema.js';
import type { Logger } from '../../infra/logger.js';
import type { Clock } from '../../shared/clock.js';
import { recordAudit } from '../audit/audit.js';
import type { SocialAccountService } from '../connections/social-account.service.js';
import type { CanonicalContent, PostSnapshot } from '../posts/content.js';
import { systemContext } from '../tenancy/tenant-context.js';
import { accountRef } from './engine.js';
import type { PublicationService } from './publication.service.js';
import type { ProviderPostRef } from './provider.js';
import type { ProviderRegistry } from './registry.js';
import { textFingerprint } from './render.js';

export interface ReconciliationDeps {
  db: Db;
  providers: ProviderRegistry;
  socialAccounts: SocialAccountService;
  publications: PublicationService;
  clock: Clock;
  logger: Logger;
  providerTimeoutMs?: number;
}

export interface ReconciliationSummary {
  checked: number;
  resolvedPublished: number;
  unresolved: number;
  unsupported: number;
  lookupFailed: number;
  exhausted: number;
}

/** Checks per ambiguous publication before it is left to the operator alone. */
export const MAX_RECONCILE_ATTEMPTS = 3;
/** How far before the attempt to look, to absorb provider clock skew. */
export const LOOKBACK_MS = 5 * 60_000;
/** How long after the attempt a matching post may appear and still count. */
export const LOOKAHEAD_MS = 30 * 60_000;

/**
 * Automatic reconciliation of `ambiguous` outcomes (architecture §7.2, Phase 1).
 * Asks the provider for posts around the attempt time and resolves to
 * `published` only on exactly one match by text fingerprint and time window.
 * Zero or several matches never resolve anything: a duplicate is worse than a
 * delayed manual review. After `MAX_RECONCILE_ATTEMPTS` the row is left alone.
 */
export class ReconciliationService {
  constructor(private readonly deps: ReconciliationDeps) {}

  async run(correlationId: string): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = {
      checked: 0,
      resolvedPublished: 0,
      unresolved: 0,
      unsupported: 0,
      lookupFailed: 0,
      exhausted: 0,
    };
    const rows = await this.deps.db
      .select()
      .from(publication)
      .where(eq(publication.state, 'ambiguous'))
      .orderBy(publication.updatedAt)
      .limit(50);
    for (const pub of rows) {
      if (pub.reconcileAttempts >= MAX_RECONCILE_ATTEMPTS) {
        summary.exhausted += 1;
        continue;
      }
      summary.checked += 1;
      const outcome = await this.reconcileOne(pub, `${correlationId}:${pub.id}`);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async reconcileOne(
    pub: Publication,
    correlationId: string,
  ): Promise<'resolvedPublished' | 'unresolved' | 'unsupported' | 'lookupFailed'> {
    const { db } = this.deps;
    const ctx = systemContext(pub.workspaceId, 'reconciliation', correlationId);
    const [account] = await db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, pub.socialAccountId))
      .limit(1);
    const [postRow] = await db.select().from(post).where(eq(post.id, pub.postId)).limit(1);
    const provider = account ? this.deps.providers.get(account.provider) : null;
    if (!account || !postRow || !provider?.lookupRecent || !account.accessTokenEnc) {
      await this.bump(pub, 'unsupported', {
        reason: !provider?.lookupRecent ? 'provider_has_no_lookup' : 'account_or_post_missing',
      });
      return 'unsupported';
    }

    // Window around the last attempt of the current cycle (or the lease start).
    const [attempt] = await db
      .select()
      .from(publishAttempt)
      .where(and(eq(publishAttempt.publicationId, pub.id), eq(publishAttempt.cycleNo, pub.cycleNo)))
      .orderBy(desc(publishAttempt.startedAt))
      .limit(1);
    const attemptAt = attempt?.startedAt ?? pub.publishingAt ?? pub.updatedAt;
    const since = new Date(attemptAt.getTime() - LOOKBACK_MS);
    const until = new Date(attemptAt.getTime() + LOOKAHEAD_MS);

    const ref = accountRef(account);
    const snapshot: PostSnapshot = {
      postId: postRow.id,
      workspaceId: postRow.workspaceId,
      title: postRow.title,
      content: postRow.content as CanonicalContent,
      contentHash: postRow.contentHash,
    };
    const rendered = provider.render(snapshot, ref);
    const expected = new Set([
      textFingerprint(rendered.plainText ?? rendered.text),
      textFingerprint(rendered.text),
    ]);

    let refs: ProviderPostRef[];
    try {
      const lookup = provider.lookupRecent.bind(provider);
      refs = await this.deps.socialAccounts.withAccessToken(ctx, account.id, 'publish', (token) =>
        lookup(ref, since, {
          credentials: { accessToken: token },
          correlationId,
          timeoutMs: this.deps.providerTimeoutMs ?? 15_000,
        }),
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, publicationId: pub.id, workspaceId: pub.workspaceId },
        'reconciliation lookup failed',
      );
      await this.bump(pub, 'lookup_failed', { message: (err as Error).message.slice(0, 300) });
      return 'lookupFailed';
    }

    const matches = refs.filter(
      (r) =>
        r.textHash !== undefined &&
        expected.has(r.textHash) &&
        (!r.publishedAt ||
          (r.publishedAt.getTime() >= since.getTime() &&
            r.publishedAt.getTime() <= until.getTime())),
    );
    if (matches.length === 1) {
      const m = matches[0]!;
      await this.deps.publications.resolve(ctx, pub.id, {
        outcome: 'published',
        providerPostId: m.providerPostId,
        ...(m.url ? { providerPostUrl: m.url } : {}),
        ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
        reason: 'reconciliation',
      });
      await recordAudit(db, {
        workspaceId: pub.workspaceId,
        actor: ctx.actor,
        entityType: 'publication',
        entityId: pub.id,
        event: 'publication.reconciled',
        fromState: 'ambiguous',
        toState: 'published',
        correlationId,
        data: {
          providerPostId: m.providerPostId,
          publishedAt: m.publishedAt?.toISOString() ?? null,
          candidates: refs.length,
          attempt: pub.reconcileAttempts + 1,
        },
      });
      this.deps.logger.info(
        { publicationId: pub.id, providerPostId: m.providerPostId },
        'ambiguous publication reconciled as published',
      );
      return 'resolvedPublished';
    }
    await this.bump(pub, matches.length === 0 ? 'no_match' : 'multiple_matches', {
      candidates: refs.length,
      matches: matches.length,
      window: { since: since.toISOString(), until: until.toISOString() },
    });
    return 'unresolved';
  }

  /** Counts the check and records why it did not resolve; never changes state. */
  private async bump(
    pub: Publication,
    reason: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db
      .update(publication)
      .set({ reconcileAttempts: sql`${publication.reconcileAttempts} + 1`, updatedAt: now })
      .where(eq(publication.id, pub.id));
    await recordAudit(this.deps.db, {
      workspaceId: pub.workspaceId,
      actor: { type: 'system', id: 'reconciliation' },
      entityType: 'publication',
      entityId: pub.id,
      event: 'publication.reconciliation_unresolved',
      data: { reason, attempt: pub.reconcileAttempts + 1, ...data },
    });
  }
}
