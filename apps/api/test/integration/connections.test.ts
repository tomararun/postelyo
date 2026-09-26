import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, contentSource, oauthState, socialAccount } from '../../src/infra/db/schema.js';
import { open } from '../../src/infra/crypto/envelope.js';
import {
  NOTION_BROKEN_DB,
  NOTION_GOOD_DB,
  NOTION_VALID_TOKEN,
  createFakeProviders,
} from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

describe('connections', () => {
  let stack: TestStack;
  const fake = createFakeProviders();

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: { LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret' },
    });
  });
  afterAll(async () => {
    await stack.close();
  });

  /** Runs start → provider redirect → callback for the given session; returns the final redirect. */
  async function connectLinkedIn(cookie: string, workspaceId: string, code = 'good-code') {
    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
      headers: { cookie },
    });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://www.linkedin.com/oauth/v2/authorization',
    );
    expect(authUrl.searchParams.get('client_id')).toBe('li-client');
    expect(authUrl.toString()).not.toContain('li-secret');
    const state = authUrl.searchParams.get('state')!;

    const cb = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=${code}&state=${state}`,
      headers: { cookie },
    });
    expect(cb.statusCode).toBe(302);
    return { state, location: locationOf(cb) };
  }

  it('connects a LinkedIn profile end to end and stores tokens only as ciphertext', async () => {
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('li'));
    const { location, state } = await connectLinkedIn(cookie, workspaceId);
    expect(location).toBe(`/w/${workspaceId}/connections?connected=linkedin`);

    // Token exchange was server-to-server with the client secret; identity fetched with the token.
    const exchange = fake.requests.find((r) => r.url.endsWith('/accessToken'));
    expect(new URLSearchParams(exchange?.body).get('client_secret')).toBe('li-secret');
    expect(new URLSearchParams(exchange?.body).get('redirect_uri')).toBe(
      'http://localhost/oauth/linkedin/callback',
    );

    // API DTO: no token material.
    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ linkedinConfigured: boolean; accounts: Record<string, unknown>[] }>();
    expect(body.linkedinConfigured).toBe(true);
    expect(body.accounts).toHaveLength(1);
    const acc = body.accounts[0]!;
    expect(acc).toMatchObject({
      provider: 'linkedin',
      accountType: 'member',
      providerAccountId: 'member-1',
      displayName: 'Alice Example',
      status: 'active',
      scopes: ['openid', 'profile', 'w_member_social'],
    });
    expect(JSON.stringify(body)).not.toContain('AQV-access');
    // Only the expiry timestamp may mention tokens; no token columns leak into the DTO.
    expect(Object.keys(acc).filter((k) => /token/i.test(k))).toEqual(['tokenExpiresAt']);

    // Database row: ciphertext only, decryptable with the correct aad.
    const [row] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, acc['id'] as string));
    expect(row?.accessTokenEnc).toBeInstanceOf(Buffer);
    expect(row!.accessTokenEnc!.toString('latin1')).not.toContain('AQV-access');
    expect(row?.credentialKeyId).toBe('k1');
    expect(
      open(stack.keyProvider, row!.accessTokenEnc!, `social_account.access_token:${row!.id}`),
    ).toBe('AQV-access-good-code');
    expect(row?.tokenExpiresAt).toBeInstanceOf(Date);

    // State is single-use.
    const [st] = await stack.db.db.select().from(oauthState).where(eq(oauthState.id, state));
    expect(st?.consumedAt).toBeInstanceOf(Date);

    const events = await stack.db.db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.entityType, 'social_account')));
    expect(events.map((e) => e.event)).toEqual(['social_account.connected']);
  });

  it('reconnecting the same profile refreshes tokens; a different profile becomes a second account', async () => {
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('li2'));
    await stack.grantPlan(workspaceId, 'agency');
    await connectLinkedIn(cookie, workspaceId, 'good-code');
    const again = await connectLinkedIn(cookie, workspaceId, 'good-code');
    expect(again.location).toContain('connected=linkedin');

    // Phase 2: any number of accounts per provider; the Notion Platforms option picks one.
    const other = await connectLinkedIn(cookie, workspaceId, 'good-code-2');
    expect(other.location).toContain('connected=linkedin');

    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    expect(
      list
        .json<{ accounts: { displayName: string }[] }>()
        .accounts.map((a) => a.displayName)
        .sort(),
    ).toEqual(['Alice Example', 'Bob Example']);

    const events = await stack.db.db
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.entityType, 'social_account')));
    expect(events.map((e) => e.event).sort()).toEqual([
      'social_account.connected',
      'social_account.connected',
      'social_account.reconnected',
    ]);
  });

  it('rejects a replayed, foreign or missing state', async () => {
    const a = await stack.signInWithWorkspace(uniqueEmail('sa'));
    const b = await stack.signInWithWorkspace(uniqueEmail('sb'));
    const { state } = await connectLinkedIn(a.cookie, a.workspaceId);

    const replay = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=good-code&state=${state}`,
      headers: { cookie: a.cookie },
    });
    expect(locationOf(replay)).toMatch(/^\/\?error=/);

    // B starts a flow, A tries to complete it with A's session.
    const startB = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${b.workspaceId}/social-accounts/linkedin/connect`,
      headers: { cookie: b.cookie },
    });
    const stateB = new URL(startB.headers.location as string).searchParams.get('state')!;
    const hijack = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=good-code&state=${stateB}`,
      headers: { cookie: a.cookie },
    });
    expect(locationOf(hijack)).toMatch(/^\/\?error=/);
    const bAccounts = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${b.workspaceId}/social-accounts`,
      headers: { cookie: b.cookie },
    });
    expect(bAccounts.json<{ accounts: unknown[] }>().accounts).toHaveLength(0);

    const missing = await stack.app.inject({
      method: 'GET',
      url: '/oauth/linkedin/callback?code=good-code',
      headers: { cookie: a.cookie },
    });
    expect(locationOf(missing)).toMatch(/^\/\?error=/);

    const anon = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?code=x&state=${stateB}`,
    });
    expect(locationOf(anon)).toBe('/sign-in');

    const mismatches = await stack.db.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.event, 'oauth.state_mismatch'));
    expect(mismatches.length).toBeGreaterThanOrEqual(3);
  });

  it('surfaces provider errors and denied authorizations without creating accounts', async () => {
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('err'));
    const bad = await connectLinkedIn(cookie, workspaceId, 'bad-code');
    expect(decodeURIComponent(bad.location)).toContain(
      'Could not complete the LinkedIn connection',
    );

    const start = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const denied = await stack.app.inject({
      method: 'GET',
      url: `/oauth/linkedin/callback?error=user_cancelled_authorize&state=${state}`,
      headers: { cookie },
    });
    expect(decodeURIComponent(locationOf(denied))).toContain('cancelled');

    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    expect(list.json<{ accounts: unknown[] }>().accounts).toHaveLength(0);
  });

  it('disconnect wipes tokens and keeps the row; cross-tenant access is 404', async () => {
    const a = await stack.signInWithWorkspace(uniqueEmail('da'));
    const b = await stack.signInWithWorkspace(uniqueEmail('db'));
    await connectLinkedIn(a.cookie, a.workspaceId);
    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${a.workspaceId}/social-accounts`,
      headers: { cookie: a.cookie },
    });
    const accountId = list.json<{ accounts: { id: string }[] }>().accounts[0]!.id;

    const foreign = await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${a.workspaceId}/social-accounts/${accountId}`,
      headers: { cookie: b.cookie },
    });
    expect(foreign.statusCode).toBe(404);
    const foreignList = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${a.workspaceId}/social-accounts`,
      headers: { cookie: b.cookie },
    });
    expect(foreignList.statusCode).toBe(404);

    const del = await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${a.workspaceId}/social-accounts/${accountId}`,
      headers: { cookie: a.cookie },
    });
    expect(del.statusCode).toBe(204);
    const [row] = await stack.db.db
      .select()
      .from(socialAccount)
      .where(eq(socialAccount.id, accountId));
    expect(row?.status).toBe('disabled');
    expect(row?.accessTokenEnc).toBeNull();
    expect(row?.credentialKeyId).toBeNull();
    expect(row?.disconnectedAt).toBeInstanceOf(Date);

    const again = await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${a.workspaceId}/social-accounts/${accountId}`,
      headers: { cookie: a.cookie },
    });
    expect(again.statusCode).toBe(404);

    // After disconnect, a different profile may be connected.
    const other = await connectLinkedIn(a.cookie, a.workspaceId, 'good-code-2');
    expect(other.location).toContain('connected=linkedin');
  });

  it('connects a Notion database after validating the template, and reports schema problems', async () => {
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('no'));
    const post = (payload: Record<string, string>) =>
      stack.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspaceId}/content-sources/notion`,
        headers: { cookie },
        payload,
      });

    const badId = await post({ token: NOTION_VALID_TOKEN, database: 'nope' });
    expect(badId.statusCode).toBe(422);
    expect(badId.json()).toMatchObject({ code: 'invalid_database_id' });

    const badToken = await post({
      token: 'ntn_wrong_token_0123456789abcdef',
      database: NOTION_GOOD_DB,
    });
    expect(badToken.statusCode).toBe(422);
    expect(badToken.json()).toMatchObject({ code: 'notion_error' });

    const broken = await post({ token: NOTION_VALID_TOKEN, database: NOTION_BROKEN_DB });
    expect(broken.statusCode).toBe(422);
    const brokenBody = broken.json<{
      code: string;
      issues: { code: string; property: string }[];
    }>();
    expect(brokenBody.code).toBe('schema_invalid');
    expect(brokenBody.issues.map((i) => `${i.code}:${i.property}`).sort()).toEqual([
      'MISSING_PROPERTY:Publish Date',
      'WRONG_TYPE:Postelyo Note',
    ]);

    const ok = await post({
      token: NOTION_VALID_TOKEN,
      database: `https://www.notion.so/acme/Content-${NOTION_GOOD_DB}?v=abc`,
    });
    expect(ok.statusCode).toBe(201);
    const dto = ok.json<Record<string, unknown>>();
    expect(dto).toMatchObject({
      kind: 'notion',
      status: 'active',
      databaseId: '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40506',
      databaseTitle: 'Content Calendar',
    });
    expect(dto['warnings']).toEqual([expect.objectContaining({ property: 'Time Zone' })]);
    expect(JSON.stringify(dto)).not.toContain(NOTION_VALID_TOKEN);

    const [row] = await stack.db.db
      .select()
      .from(contentSource)
      .where(eq(contentSource.id, dto['id'] as string));
    expect(row!.credentialEnc!.toString('latin1')).not.toContain(NOTION_VALID_TOKEN);
    expect(
      open(stack.keyProvider, row!.credentialEnc!, `content_source.credential:${row!.id}`),
    ).toBe(NOTION_VALID_TOKEN);
    expect(
      (row!.config as { propertyMap: Record<string, string> }).propertyMap['Publish Date'],
    ).toBe('Publish Date');

    // Reconnecting the same database updates; another database is a conflict.
    expect((await post({ token: NOTION_VALID_TOKEN, database: NOTION_GOOD_DB })).statusCode).toBe(
      201,
    );
    // A database Notion cannot find → 422 notion_error (never a 5xx).
    const other = await post({
      token: NOTION_VALID_TOKEN,
      database: 'ffffffffeeeeddddccccbbbbaaaa9999',
    });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'notion_error' });

    const list = await stack.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/content-sources`,
      headers: { cookie },
    });
    expect(list.json<{ sources: unknown[] }>().sources).toHaveLength(1);

    const del = await stack.app.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/content-sources/${dto['id'] as string}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    const [after] = await stack.db.db
      .select()
      .from(contentSource)
      .where(eq(contentSource.id, dto['id'] as string));
    expect(after?.credentialEnc).toBeNull();
    expect(after?.status).toBe('disabled');
  });

  it('renders the connections page and accepts the Notion form', async () => {
    const { cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('pg'));
    const page = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/connections`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Connect LinkedIn profile');
    expect(page.body).toContain('Connect Notion database');

    const form = await stack.app.inject({
      method: 'POST',
      url: `/w/${workspaceId}/connections/notion`,
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      payload: `token=${encodeURIComponent(NOTION_VALID_TOKEN)}&database=${NOTION_GOOD_DB}`,
    });
    expect(form.statusCode).toBe(302);
    expect(decodeURIComponent(locationOf(form))).toContain('connected');

    const after = await stack.app.inject({
      method: 'GET',
      url: `/w/${workspaceId}/connections`,
      headers: { cookie },
    });
    expect(after.body).toContain('Content Calendar');
    expect(after.body).not.toContain(NOTION_VALID_TOKEN);

    const anon = await stack.app.inject({ method: 'GET', url: `/w/${workspaceId}/connections` });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/sign-in');
  });
});
