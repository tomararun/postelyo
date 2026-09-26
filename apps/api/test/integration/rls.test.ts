import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { post, publication, socialAccount, workspace } from '../../src/infra/db/schema.js';
import { RLS_TABLES, withTenantScope } from '../../src/infra/db/tenant-scope.js';
import { uuidv7 } from '../../src/shared/ids.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Row-level security as the second tenancy defence (architecture §4 item 7).
 * The suite connects as a restricted role; a superuser would bypass every
 * policy and make these assertions meaningless, so that is checked first.
 */
describe('row-level security', () => {
  let stack: TestStack;
  let wsA: string;
  let wsB: string;
  let postA: string;
  let postB: string;

  beforeAll(async () => {
    stack = await createTestStack();
    ({ workspaceId: wsA } = await stack.signInWithWorkspace(uniqueEmail('rls-a')));
    ({ workspaceId: wsB } = await stack.signInWithWorkspace(uniqueEmail('rls-b')));
    postA = uuidv7();
    postB = uuidv7();
    for (const [id, ws] of [
      [postA, wsA],
      [postB, wsB],
    ] as const) {
      await stack.db.db.insert(post).values({
        id,
        workspaceId: ws,
        title: `post of ${ws}`,
        state: 'draft',
        content: {},
      });
    }
  });
  afterAll(async () => {
    // The scheduler tick is global: withdraw the rows this suite created.
    await stack.db.db
      .update(publication)
      .set({ state: 'cancelled' })
      .where(eq(publication.workspaceId, wsB));
    await stack.close();
  });

  it('runs the application as a role that is subject to RLS', async () => {
    const rows = await stack.db.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const r = [...rows][0]!;
    expect(r.rolsuper).toBe(false);
    expect(r.rolbypassrls).toBe(false);
  });

  it('forces RLS on every tenant table', async () => {
    const rows = await stack.db.db.execute<{ name: string; forced: boolean }>(sql`
      select c.relname as name, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`);
    const forced = [...rows].filter((t) => t.forced).map((t) => t.name);
    for (const t of RLS_TABLES) expect(forced, t).toContain(t);
  });

  it('hides other tenants from a scoped query that forgot its WHERE clause', async () => {
    const unscoped = await stack.db.db.select({ id: post.id }).from(post);
    expect(unscoped.map((p) => p.id)).toEqual(expect.arrayContaining([postA, postB]));

    const scoped = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.select({ id: post.id, workspaceId: post.workspaceId }).from(post),
    );
    expect(scoped.map((p) => p.id)).toContain(postA);
    expect(scoped.every((p) => p.workspaceId === wsA)).toBe(true);

    const byId = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.select({ id: post.id }).from(post).where(eq(post.id, postB)),
    );
    expect(byId).toEqual([]);

    const otherWorkspace = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, wsB)),
    );
    expect(otherWorkspace).toEqual([]);
  });

  it('rejects writes into another tenant and updates that would move a row across tenants', async () => {
    const err = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.insert(post).values({
        id: uuidv7(),
        workspaceId: wsB,
        title: 'smuggled',
        state: 'draft',
        content: {},
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Drizzle wraps the driver error; the Postgres code for a policy violation is 42501.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/);

    const moved = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.update(post).set({ title: 'touched' }).where(eq(post.id, postB)).returning(),
    );
    expect(moved).toEqual([]);
    const [b] = await stack.db.db.select().from(post).where(eq(post.id, postB));
    expect(b?.title).toBe(`post of ${wsB}`);

    // Deleting through the wrong scope is a silent no-op, never a cross-tenant delete.
    const deleted = await withTenantScope(stack.db.db, wsA, (tx) =>
      tx.delete(post).where(eq(post.id, postB)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  it('leaves the pooled connection unscoped after the transaction', async () => {
    await withTenantScope(stack.db.db, wsA, async (tx) => {
      const rows = await tx.execute<{ v: string }>(
        sql`select current_setting('app.workspace_id', true) as v`,
      );
      expect([...rows][0]?.v).toBe(wsA);
    });
    // Drain a few connections from the pool: none should carry the setting.
    for (let i = 0; i < 6; i++) {
      const rows = await stack.db.db.execute<{ v: string | null }>(
        sql`select nullif(current_setting('app.workspace_id', true), '') as v`,
      );
      expect([...rows][0]?.v ?? null).toBeNull();
    }
  });

  it('keeps the tenant-facing services inside their workspace', async () => {
    // Accounts and publications created directly in B are invisible through A's context.
    const accId = uuidv7();
    await stack.db.db.insert(socialAccount).values({
      id: accId,
      workspaceId: wsB,
      provider: 'linkedin',
      accountType: 'member',
      providerAccountId: 'rls-b-member',
      displayName: 'B member',
      status: 'active',
    });
    const pubId = uuidv7();
    await stack.db.db.insert(publication).values({
      id: pubId,
      workspaceId: wsB,
      postId: postB,
      socialAccountId: accId,
      provider: 'linkedin',
      state: 'scheduled',
      scheduledAt: new Date(),
      scheduledTz: 'UTC',
      scheduledLocal: '2026-01-01T09:00',
    });
    const ctxA = {
      workspaceId: wsA,
      actor: { type: 'system' as const, id: 'test' },
      correlationId: 'c',
    };
    expect(await stack.services.socialAccounts.get(ctxA, accId)).toBeNull();
    expect(await stack.services.publications.get(ctxA, pubId)).toBeNull();
    expect((await stack.services.socialAccounts.list(ctxA)).map((a) => a.id)).not.toContain(accId);
  });
});
