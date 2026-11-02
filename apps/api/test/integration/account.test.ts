import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { auditLog, membership, socialAccount, user, workspace } from '../../src/infra/db/schema.js';
import { createFakeProviders } from './fake-providers.js';
import { createTestStack, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Self-service account deletion and data export (D64, D65). Two people share a
 * team workspace owned by Bea; Alex is an admin there and has connected a
 * LinkedIn profile. Each also has the personal workspace created at sign-up.
 */
describe('account deletion and data export', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  let alexEmail: string;
  let alexCookie: string;
  let alexId: string;
  let alexOwnWs: string;
  let beaCookie: string;
  let teamWs: string;
  let alexAccountId: string;

  const inject = (
    cookie: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    stack.app.inject({
      method,
      url,
      headers: {
        cookie,
        ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: { LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret' },
    });
    alexEmail = uniqueEmail('acct-alex');
    ({ cookie: alexCookie, workspaceId: alexOwnWs } = await stack.signInWithWorkspace(alexEmail));
    alexId = (await inject(alexCookie, 'GET', '/v1/me')).json<{ user: { id: string } }>().user.id;
    ({ cookie: beaCookie, workspaceId: teamWs } = await stack.signInWithWorkspace(
      uniqueEmail('acct-bea'),
    ));
    await stack.grantPlan(teamWs, 'team');
    const invite = await inject(beaCookie, 'POST', `/v1/workspaces/${teamWs}/invitations`, {
      email: alexEmail,
      role: 'admin',
    });
    expect(invite.statusCode).toBe(201);
    const token = stack.mailer
      .lastTo(alexEmail)!
      .text.match(/\/invitations\/([A-Za-z0-9_-]+)/)![1]!;
    const accept = await inject(alexCookie, 'POST', `/v1/invitations/${token}/accept`, {});
    expect(accept.statusCode).toBe(200);
    // Alex connects a personal LinkedIn profile inside Bea's team workspace.
    const start = await inject(
      alexCookie,
      'GET',
      `/v1/workspaces/${teamWs}/social-accounts/linkedin/connect`,
    );
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await inject(alexCookie, 'GET', `/oauth/linkedin/callback?code=good-code&state=${state}`);
    const [acc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(
        and(eq(socialAccount.workspaceId, teamWs), eq(socialAccount.connectedByUserId, alexId)),
      );
    expect(acc?.accessTokenEnc).not.toBeNull();
    alexAccountId = acc!.id;
  });
  afterAll(async () => {
    await stack.close();
  });

  it('exports the personal data of the signed-in user without any secret', async () => {
    const res = await inject(alexCookie, 'GET', '/v1/me/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="postelyo-account-/);
    const body = res.json<{
      kind: string;
      user: { email: string };
      memberships: { workspaceId: string; role: string }[];
      sessions: unknown[];
      activity: { events: { event: string }[] };
    }>();
    expect(body.kind).toBe('postelyo.account-export');
    expect(body.user.email).toBe(alexEmail);
    expect(body.memberships.map((m) => m.workspaceId).sort()).toEqual([alexOwnWs, teamWs].sort());
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.activity.events.some((e) => e.event === 'social_account.connected')).toBe(true);
    expect(res.body).not.toMatch(/AQV-access|token_hash|tokenHash|"token"/);
    const anon = await stack.app.inject({ method: 'GET', url: '/v1/me/export' });
    expect(anon.statusCode).toBe(401);
  });

  it('exports a workspace for admins, without tokens, and audits it', async () => {
    const res = await inject(alexCookie, 'GET', `/v1/workspaces/${teamWs}/export`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      kind: string;
      members: { email: string; role: string }[];
      socialAccounts: { id: string; provider: string }[];
      posts: unknown[];
    }>();
    expect(body.kind).toBe('postelyo.workspace-export');
    expect(body.members.map((m) => m.role).sort()).toEqual(['admin', 'owner']);
    expect(body.socialAccounts.map((a) => a.id)).toContain(alexAccountId);
    expect(res.body).not.toMatch(/AQV-access|accessTokenEnc|refreshTokenEnc|credentialEnc/);
    const stranger = await stack.signInWithWorkspace(uniqueEmail('acct-stranger'));
    const denied = await inject(stranger.cookie, 'GET', `/v1/workspaces/${teamWs}/export`);
    expect(denied.statusCode).toBe(404);
    const [audit] = await stack.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, teamWs), eq(auditLog.event, 'workspace.exported')));
    expect(audit).toBeDefined();
  });

  it('blocks deleting the only owner of a workspace that still has members', async () => {
    const preview = await inject(beaCookie, 'GET', '/v1/me/deletion-preview');
    expect(preview.json<{ blocking: { id: string }[] }>().blocking.map((b) => b.id)).toEqual([
      teamWs,
    ]);
    const me = (await inject(beaCookie, 'GET', '/v1/me')).json<{ user: { email: string } }>();
    const res = await inject(beaCookie, 'DELETE', '/v1/me', { confirmEmail: me.user.email });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string; workspaces: { id: string }[] }>()).toMatchObject({
      code: 'blocked',
      workspaces: [{ id: teamWs }],
    });
  });

  it('previews, confirms and deletes an account with every side effect', async () => {
    const preview = (await inject(alexCookie, 'GET', '/v1/me/deletion-preview')).json<{
      deleted: { id: string }[];
      left: { id: string; connectedAccounts: number }[];
      blocking: unknown[];
    }>();
    expect(preview.deleted.map((d) => d.id)).toEqual([alexOwnWs]);
    expect(preview.left).toEqual([expect.objectContaining({ id: teamWs, connectedAccounts: 1 })]);
    expect(preview.blocking).toEqual([]);

    const wrong = await inject(alexCookie, 'DELETE', '/v1/me', {
      confirmEmail: 'nope@example.com',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ code: string }>().code).toBe('confirm_mismatch');
    const crossSite = await inject(
      alexCookie,
      'DELETE',
      '/v1/me',
      { confirmEmail: alexEmail },
      { origin: 'https://evil.example' },
    );
    expect(crossSite.statusCode).toBe(403);

    stack.enqueue.reset();
    const sentBefore = stack.mailer.sent.length;
    const res = await inject(alexCookie, 'DELETE', '/v1/me', {
      confirmEmail: alexEmail.toUpperCase(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ accountDeleted: boolean }>().accountDeleted).toBe(true);

    // Signed out everywhere, user row gone, memberships gone.
    expect((await inject(alexCookie, 'GET', '/v1/me')).statusCode).toBe(401);
    expect(await stack.db.db.select().from(user).where(eq(user.id, alexId))).toHaveLength(0);
    expect(
      await stack.db.db.select().from(membership).where(eq(membership.userId, alexId)),
    ).toHaveLength(0);
    // The personal workspace is on its way out through the normal purge.
    const [own] = await stack.db.db.select().from(workspace).where(eq(workspace.id, alexOwnWs));
    expect(own?.deletedAt).not.toBeNull();
    expect(stack.enqueue.deletions.map((d) => d.workspaceId)).toContain(alexOwnWs);
    // The team keeps its workspace but can no longer post as Alex.
    const [acc] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, alexAccountId));
    expect(acc).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null });
    expect(acc!.disconnectedAt).not.toBeNull();
    expect(acc!.connectedByUserId).toBeNull();
    const [team] = await stack.db.db.select().from(workspace).where(eq(workspace.id, teamWs));
    expect(team?.deletedAt).toBeNull();
    // Audited without the email; confirmation mail sent.
    const [deleted] = await stack.db.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, 'user.deleted'),
          eq(auditLog.entityId, alexId),
          isNull(auditLog.workspaceId),
        ),
      );
    expect(deleted?.data).toMatchObject({
      workspacesDeleted: 1,
      workspacesLeft: 1,
      accountsDisconnected: 1,
    });
    expect(JSON.stringify(deleted?.data)).not.toContain(alexEmail);
    const [left] = await stack.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, teamWs), eq(auditLog.event, 'membership.removed')));
    expect(left?.data).toMatchObject({ reason: 'account_deleted' });
    expect(stack.mailer.sent.length).toBe(sentBefore + 1);
    expect(stack.mailer.lastTo(alexEmail)?.subject).toBe('Your Postelyo account has been deleted');

    // Bea is now the only member of the team workspace: nothing blocks her anymore.
    const beaPreview = (await inject(beaCookie, 'GET', '/v1/me/deletion-preview')).json<{
      deleted: { id: string }[];
      blocking: unknown[];
    }>();
    expect(beaPreview.blocking).toEqual([]);
    expect(beaPreview.deleted.map((d) => d.id)).toContain(teamWs);
  });
});
