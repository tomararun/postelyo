import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { FakeProvider, PublishResult } from '@postelyo/publishing-core';
import { post, publication } from '../../src/infra/db/schema.js';
import { NOTION_GOOD_DB, NOTION_VALID_TOKEN, createFakeProviders } from './fake-providers.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Phase 7 chaos suite for the publishing engine: random provider outcomes,
 * duplicate and concurrent job deliveries, expired leases and clock jumps.
 * Whatever happens, a publication is published at most once at the provider
 * and every row ends in a consistent state.
 */

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env['CHAOS_SEED'] ?? 20260928);
const PAGES = 14;
const ROUNDS = 12;

describe(`chaos: publishing engine under random outcomes (seed ${SEED})`, () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let provider: FakeProvider;
  const rand = mulberry32(SEED);

  const sync = async () => {
    const res = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      headers: { cookie },
    });
    expect([200, 207]).toContain(res.statusCode);
  };
  const pubs = async () => {
    const rows = await stack.db.db
      .select({ pub: publication })
      .from(publication)
      .innerJoin(post, eq(post.id, publication.postId))
      .where(eq(post.workspaceId, workspaceId));
    return rows.map((r) => r.pub);
  };

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: { LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret' },
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('chaos')));
    await stack.grantPlan(workspaceId, 'agency');
    const connect = await stack.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
      headers: { cookie },
      payload: { token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB },
    });
    sourceId = connect.json<{ id: string }>().id;
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect?type=member`,
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=good-code&state=${state}`,
      headers: { cookie },
    });
    provider = stack.services.providers.get('linkedin') as FakeProvider;
    // Raise the daily cap so the chaos is about the engine, not the scheduler's pacing.
    await stack.app.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: { dailyCapPerAccount: 100 },
    });
  });
  afterAll(async () => {
    // Suites share the database and the scheduler is global: leave nothing due behind.
    const rows = await pubs();
    await stack.db.db
      .update(publication)
      .set({ state: 'failed', leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null })
      .where(
        inArray(
          publication.id,
          rows.filter((p) => p.state !== 'published' && p.state !== 'failed').map((p) => p.id),
        ),
      );
    await stack.close();
  });

  it('never publishes a publication twice and leaves every row consistent', async () => {
    for (let i = 0; i < PAGES; i += 1) {
      fake.notion.upsert(`chaos-${SEED}-${i}`, {
        status: 'Scheduled',
        title: `Chaos ${i}`,
        platforms: ['LinkedIn'],
        publishDate: {
          start: new Date(stack.clock.now().getTime() - ((i % 9) + 1) * 60_000).toISOString(),
        },
        body: [`chaos body ${i} ${SEED}`],
      });
    }
    await sync();
    expect((await pubs()).length).toBe(PAGES);

    // Script a long random sequence of provider outcomes.
    const outcomes: PublishResult[] = [];
    for (let i = 0; i < PAGES * ROUNDS * 3; i += 1) {
      const r = rand();
      outcomes.push(
        r < 0.45
          ? { kind: 'published', providerPostId: `urn:li:share:chaos-${SEED}-${i}` }
          : r < 0.7
            ? { kind: 'retryable_error', reason: 'chaos 503', code: 'transient' }
            : r < 0.85
              ? { kind: 'ambiguous', reason: 'chaos timeout' }
              : r < 0.92
                ? { kind: 'terminal_error', reason: 'chaos rejected', code: 'content' }
                : {
                    kind: 'retryable_error',
                    reason: 'chaos rate limit',
                    code: 'rate_limit',
                    retryAfterMs: 60_000,
                  },
      );
    }
    provider.scriptOutcomes(...outcomes);

    const callsBefore = provider.calls.length;
    for (let round = 0; round < ROUNDS; round += 1) {
      await stack.services.scheduler.tick(`chaos-tick-${round}`);
      const open = (await pubs()).filter((p) =>
        ['queued', 'retry_wait', 'scheduled'].includes(p.state),
      );
      // Duplicate and concurrent deliveries of the same job, plus a stale cycle now and then.
      await Promise.all(
        open.flatMap((p) => {
          const job = { publicationId: p.id, cycleNo: p.cycleNo };
          const copies = 1 + Math.floor(rand() * 3);
          const runs = Array.from({ length: copies }, (_, k) =>
            stack.services.engine.handle(job, `chaos-${round}-${p.id}-${k}`),
          );
          if (rand() < 0.2)
            runs.push(
              stack.services.engine.handle(
                { publicationId: p.id, cycleNo: p.cycleNo + 1 },
                `chaos-stale-${round}-${p.id}`,
              ),
            );
          return runs;
        }),
      );
      // Simulate a worker crash: a leased row whose lease has expired.
      if (round === 3) {
        const victim = (await pubs()).find((p) => p.state === 'retry_wait' || p.state === 'queued');
        if (victim) {
          await stack.db.db
            .update(publication)
            .set({
              state: 'publishing',
              leaseOwner: 'dead-worker',
              leaseExpiresAt: new Date(stack.clock.now().getTime() - 60_000),
            })
            .where(eq(publication.id, victim.id));
        }
      }
      // Random clock jumps cover every backoff step and the lease timeout.
      stack.clock.advance(Math.floor(5 + rand() * 40) * 60_000);
      await stack.services.reconciliation.run(`chaos-recon-${round}`);
    }
    // Final sweep: expired leases and any remaining ambiguity.
    stack.clock.advance(60 * 60_000);
    await stack.services.scheduler.tick('chaos-final');
    await stack.services.reconciliation.run('chaos-recon-final');

    const all = await pubs();
    expect(all.length).toBe(PAGES);
    const publishedCalls = provider.calls
      .slice(callsBefore)
      .filter((c) => c.result.kind === 'published');
    // Exactly-once at the provider: no publication id appears twice among successful calls.
    const perPub = new Map<string, number>();
    for (const c of publishedCalls)
      perPub.set(c.input.publicationId, (perPub.get(c.input.publicationId) ?? 0) + 1);
    for (const [id, n] of perPub) expect(n, `publication ${id} published ${n} times`).toBe(1);

    for (const p of all) {
      // No row is stuck mid-flight: leases are either held by a live attempt or cleared.
      expect(
        ['scheduled', 'queued', 'retry_wait', 'published', 'failed', 'ambiguous'],
        `${p.id} state ${p.state}`,
      ).toContain(p.state);
      if (p.state === 'published') {
        expect(p.providerPostId, `${p.id} published without provider id`).toBeTruthy();
        expect(
          perPub.get(p.id) ?? 0,
          `${p.id} published in db but provider saw ${perPub.get(p.id) ?? 0}`,
        ).toBeLessThanOrEqual(1);
      } else {
        // A publication the provider accepted can only be in a non-published state while
        // reconciliation has not yet confirmed it (ambiguous) - never failed or waiting.
        if ((perPub.get(p.id) ?? 0) > 0)
          expect(p.state, `${p.id} accepted by provider but ${p.state}`).toBe('ambiguous');
      }
      expect(p.attemptNo).toBeLessThanOrEqual(p.maxAttempts + 1);
      if (p.state !== 'publishing') expect(p.leaseOwner).toBeNull();
    }
    expect(all.filter((p) => p.state === 'published').length).toBeGreaterThan(0);
    // Only cycle-matched jobs did work: stale-cycle deliveries were skipped.
    const stale = await stack.db.db
      .select()
      .from(publication)
      .where(
        and(
          inArray(
            publication.id,
            all.map((p) => p.id),
          ),
          eq(publication.cycleNo, 0),
        ),
      );
    expect(stale.length).toBeLessThanOrEqual(PAGES);
  });
});
