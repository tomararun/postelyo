import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  aiGeneration,
  auditLog,
  mediaAsset,
  post,
  publication,
} from '../../src/infra/db/schema.js';
import { AiProviderError, FakeAiProvider } from '../../src/modules/ai/provider.js';
import { bannedPhraseHit } from '../../src/modules/ai/ai.service.js';
import { extractJson } from '../../src/modules/ai/prompts.js';
import { PLANS } from '../../src/modules/billing/plans.js';
import { FILES_HOST, createFakeProviders } from './fake-providers.js';
import { createTestStack, locationOf, uniqueEmail, type TestStack } from './helpers.js';

/**
 * Phase 6 AI assistance through the fake provider: flags and entitlements,
 * budget cap, audit rows, variants that never overwrite human text, banned
 * phrase guardrail, repurposing, drafts from ideas, alt text, and approval
 * enforcement on AI-assisted posts.
 */
describe('phase 6 AI assistance', () => {
  let stack: TestStack;
  const fake = createFakeProviders();
  const ai = new FakeAiProvider();
  let cookie: string;
  let workspaceId: string;
  let sourceId: string;
  let ideasDb: string;
  let contentDb: string;

  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    c = cookie,
  ) =>
    stack.app.inject({
      method,
      url,
      headers: {
        cookie: c,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const sync = async () => {
    const res = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/sync`,
      {},
    );
    expect([200, 207]).toContain(res.statusCode);
    return res.json<{
      errors: string[];
      extras?: Record<string, unknown> & { warnings: string[] };
    }>();
  };
  // Fake page ids repeat across suites sharing the database; scope by workspace.
  const postByPage = async (pageId: string) =>
    (
      await stack.db.db
        .select()
        .from(post)
        .where(and(eq(post.externalId, pageId), eq(post.workspaceId, workspaceId)))
    )[0]!;
  const generations = () =>
    stack.db.db.select().from(aiGeneration).where(eq(aiGeneration.workspaceId, workspaceId));

  beforeAll(async () => {
    stack = await createTestStack({
      fetchImpl: fake.fetchImpl,
      env: {
        LINKEDIN_CLIENT_ID: 'li-client',
        LINKEDIN_CLIENT_SECRET: 'li-secret',
        NOTION_CLIENT_ID: 'notion-client',
        NOTION_CLIENT_SECRET: 'notion-secret',
      },
      aiProvider: ai,
    });
    ({ cookie, workspaceId } = await stack.signInWithWorkspace(uniqueEmail('p6')));
    await stack.grantPlan(workspaceId, 'team');
    const start = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/content-sources/notion/connect`,
    );
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await inject('GET', `/oauth/notion/callback?code=notion-good&state=${state}`);
    sourceId = new URL(locationOf(cb), 'http://localhost').searchParams.get('source')!;
    const options = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
    );
    const parent = options.json<{ pages: { id: string }[] }>().pages[0]!.id;
    const done = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/content-sources/${sourceId}/setup`,
      {
        mode: 'create',
        parentPageId: parent,
      },
    );
    const dto = done.json<{ databaseId: string; ideasDatabaseId: string }>();
    contentDb = dto.databaseId;
    ideasDb = dto.ideasDatabaseId;
    const li = await inject(
      'GET',
      `/v1/workspaces/${workspaceId}/social-accounts/linkedin/connect`,
    );
    const liState = new URL(li.headers.location as string).searchParams.get('state')!;
    await inject('GET', `/oauth/linkedin/callback?code=good-code&state=${liState}`);
  });
  afterAll(async () => {
    await stack.close();
  });

  it('parses model output tolerantly and applies the banned-phrase guardrail', () => {
    expect(extractJson<{ a: number }>('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson<{ a: number }>('Here you go: {"a": 2}')).toEqual({ a: 2 });
    expect(extractJson('not json')).toBeNull();
    expect(bannedPhraseHit('We are Thrilled To Announce this', ['thrilled to announce'])).toBe(
      'thrilled to announce',
    );
    expect(bannedPhraseHit('plain text', ['synergy'])).toBeNull();
  });

  it('is off by default, needs the workspace switch and a plan with AI tokens, and reports usage', async () => {
    let res = await inject('GET', `/v1/workspaces/${workspaceId}/ai`);
    expect(res.statusCode).toBe(200);
    let u = res.json<{
      usage: { enabled: boolean; entitled: boolean; budgetTokens: number; provider: string };
    }>().usage;
    expect(u.enabled).toBe(false);
    expect(u.entitled).toBe(true);
    expect(u.budgetTokens).toBe(PLANS.team.limits.aiTokensPerMonth);
    expect(u.provider).toBe('fake');

    // The trigger is ignored while AI is off; nothing is generated and the box is unticked with a note.
    fake.notion.upsert('p6-off', {
      status: 'Draft',
      title: 'Off',
      platforms: ['LinkedIn', 'X'],
      body: ['some text'],
      generateVariants: true,
    });
    let s = await sync();
    expect(s.extras?.['aiVariants']).toBe(0);
    expect(s.extras?.warnings.some((w) => w.includes('off for this workspace'))).toBe(true);
    expect(fake.notion.pages.get('p6-off')!.generateVariants).toBe(false);
    expect(fake.notion.pages.get('p6-off')!.system.postelyoNote).toContain(
      'Postelyo AI: could not',
    );
    expect(await generations()).toHaveLength(0);

    // Free plan: switch on but not entitled.
    await stack.grantPlan(workspaceId, 'free');
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      ai: {
        enabled: true,
        voice: 'Warm, direct, no jargon.',
        bannedPhrases: ['thrilled to announce', 'synergy'],
      },
    });
    res = await inject('GET', `/v1/workspaces/${workspaceId}/ai`);
    u = res.json<{
      usage: { enabled: boolean; entitled: boolean; budgetTokens: number; provider: string };
    }>().usage;
    expect(u.enabled).toBe(true);
    expect(u.entitled).toBe(false);
    fake.notion.upsert('p6-off', { generateVariants: true });
    s = await sync();
    expect(s.extras?.warnings.some((w) => w.includes('does not include AI'))).toBe(true);
    await stack.grantPlan(workspaceId, 'team');
  });

  it('generates variants only for empty platform fields, keeps human text, notes it, and audits', async () => {
    fake.notion.upsert('p6-var', {
      status: 'Draft',
      title: 'Launch day',
      platforms: ['LinkedIn', 'X', 'Instagram'],
      body: ['We shipped the new onboarding today. #launch', 'Three lessons inside.'],
      platformText: { 'X Text': 'my own short version' },
      generateVariants: true,
    });
    const s = await sync();
    expect(s.extras?.['aiVariants']).toBe(2);
    const page = fake.notion.pages.get('p6-var')!;
    expect(page.generateVariants).toBe(false);
    expect(page.platformText['X Text']).toBe('my own short version');
    expect(page.platformText['LinkedIn Text']).toBe(
      '[linkedin] We shipped the new onboarding today. #launch',
    );
    expect(page.platformText['Instagram Caption']).toBe(
      '[instagram] We shipped the new onboarding today. #launch',
    );
    expect(page.system.postelyoNote).toContain('Postelyo AI: suggested LinkedIn, Instagram text');
    expect(page.system.postelyoNote).toContain('Kept your own text for X');
    // The prompt carried the voice and the guardrail, and the call was recorded with cost.
    const call = ai.calls.at(-1)!;
    expect(call.req.purpose).toBe('variants');
    expect(call.req.system).toContain('BRAND VOICE');
    expect(call.req.system).toContain('"synergy"');
    expect(call.req.prompt).toContain('platforms: linkedin, instagram');
    const rows = await generations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'variants',
      outcome: 'ok',
      provider: 'fake',
      model: 'claude-opus-5',
    });
    expect(rows[0]!.totalTokens).toBeGreaterThan(0);
    expect(Number(rows[0]!.costUsd)).toBeGreaterThan(0);
    expect(rows[0]!.promptText).not.toContain('sk-ant');
    const row = await postByPage('p6-var');
    expect(row.aiAssisted).toBe(true);
    const audits = await stack.db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));
    expect(audits.some((a) => a.event === 'ai.generated')).toBe(true);
    expect(audits.some((a) => a.event === 'ai.assisted')).toBe(true);
    // A second sync does nothing: the trigger was reset.
    const again = await sync();
    expect(again.extras?.['aiVariants']).toBe(0);
    expect(await generations()).toHaveLength(1);
  });

  it('discards output that contains a banned phrase and records the guardrail outcome', async () => {
    ai.decide = () => JSON.stringify({ linkedin: 'We are thrilled to announce synergy.' });
    try {
      fake.notion.upsert('p6-banned', {
        status: 'Draft',
        title: 'Banned',
        platforms: ['LinkedIn'],
        body: ['announcement'],
        generateVariants: true,
      });
      const s = await sync();
      expect(s.extras?.['aiVariants']).toBe(0);
      expect(s.extras?.warnings.some((w) => w.includes('banned phrase'))).toBe(true);
      const page = fake.notion.pages.get('p6-banned')!;
      expect(page.platformText['LinkedIn Text']).toBeUndefined();
      expect(page.system.postelyoNote).toContain('could not generate');
      const rows = (await generations()).filter((g) => g.outcome === 'guardrail');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.error).toContain('thrilled to announce');
    } finally {
      ai.decide = null;
    }
  });

  it('stops at the monthly budget and reports provider errors without crashing the sync', async () => {
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      ai: { enabled: true, monthlyTokenBudget: 1 },
    });
    fake.notion.upsert('p6-budget', {
      status: 'Draft',
      title: 'Budget',
      platforms: ['LinkedIn'],
      body: ['text'],
      generateVariants: true,
    });
    let s = await sync();
    expect(s.extras?.warnings.some((w) => w.includes('budget'))).toBe(true);
    const before = (await generations()).length;
    const manual = await inject(
      'POST',
      `/v1/workspaces/${workspaceId}/posts/${(await postByPage('p6-budget')).id}/ai/variants`,
      {},
    );
    expect(manual.statusCode).toBe(402);
    expect(manual.json<{ code: string }>().code).toBe('budget');
    expect((await generations()).length).toBe(before);

    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      ai: { enabled: true, bannedPhrases: ['synergy'] },
    });
    ai.decide = () =>
      new AiProviderError('rate_limit', 'The AI provider is rate limiting requests.', true);
    try {
      fake.notion.upsert('p6-budget', { generateVariants: true });
      s = await sync();
      expect(s.errors).toEqual([]);
      expect(s.extras?.warnings.some((w) => w.includes('rate limiting'))).toBe(true);
      const rows = (await generations()).filter((g) => g.outcome === 'error');
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      ai.decide = null;
    }
  });

  it('repurposes a post into linked draft pages and clears the trigger', async () => {
    fake.notion.upsert('p6-long', {
      status: 'Draft',
      title: 'Long form',
      platforms: ['X'],
      body: ['A long article body with several claims.'],
      repurpose: 'Thread',
    });
    let s = await sync();
    expect(s.extras?.['aiRepurposed']).toBe(1);
    const source = fake.notion.pages.get('p6-long')!;
    expect(source.repurpose).toBeNull();
    expect(source.system.postelyoNote).toContain('created 1 draft page(s) (thread)');
    const thread = fake.notion.pages.get(fake.notion.createdPages.at(-1)!)!;
    expect(thread.databaseId).toBe(contentDb);
    expect(thread.title).toBe('Long form · thread');
    expect(thread.status).toBe('Draft');
    expect(thread.repeatOf).toEqual(['p6-long']);
    expect(fake.notion.bodyOf(thread.id)).toEqual([
      'Thread 1 · thread part 1: First piece of the repurposed content.',
      'Thread 2 · thread part 2: Second piece of the repurposed content.',
    ]);

    fake.notion.upsert('p6-long', { repurpose: 'Short variants' });
    s = await sync();
    expect(s.extras?.['aiRepurposed']).toBe(2);
    const variants = fake.notion.createdPages.slice(-2).map((id) => fake.notion.pages.get(id)!);
    expect(variants.map((v) => v.title)).toEqual([
      'short_variants part 1',
      'short_variants part 2',
    ]);
    expect(variants.every((v) => v.status === 'Draft' && v.repeatOf[0] === 'p6-long')).toBe(true);
    // The drafts are ordinary pages: the next sync ingests them as drafts, nothing is published.
    await sync();
    for (const v of variants) expect((await postByPage(v.id)).state).toBe('draft');
    expect(
      await stack.db.db.select().from(publication).where(eq(publication.workspaceId, workspaceId)),
    ).toHaveLength(0);
  });

  it('writes a draft from an idea marked "Draft with AI"', async () => {
    fake.notion.upsert('idea-ai', {
      databaseId: ideasDb,
      title: 'Onboarding lessons',
      status: 'Draft with AI',
      postText: 'What we learned rewriting onboarding',
      platforms: ['LinkedIn'],
      body: ['lesson one', 'lesson two'],
    });
    const s = await sync();
    expect(s.extras?.['promoted']).toBe(1);
    const idea = fake.notion.pages.get('idea-ai')!;
    expect(idea.status).toBe('Promoted');
    const draft = fake.notion.pages.get(fake.notion.createdPages.at(-1)!)!;
    expect(draft.title).toBe('Onboarding lessons');
    expect(draft.status).toBe('Draft');
    const body = fake.notion.bodyOf(draft.id);
    expect(body[0]).toBe('Onboarding lessons');
    expect(body).toContain('A first paragraph written by the fake model.');
    expect(body).toContain('Original idea notes:');
    expect(body).toContain('lesson one');
    expect(draft.system.postelyoNote).toContain('Postelyo AI: draft written from the idea');
    const call = ai.calls.at(-1)!;
    expect(call.req.purpose).toBe('draft_from_idea');
    expect(call.req.prompt).toContain('TITLE: Onboarding lessons');
    const row = await postByPage(draft.id);
    expect(row.aiAssisted).toBe(true);
    expect(row.state).toBe('draft');
  });

  it('generates alt text for images without a description and uses it when rendering', async () => {
    fake.notion.upsert('p6-alt', {
      status: 'Scheduled',
      title: 'Picture post',
      platforms: ['LinkedIn'],
      publishDate: { start: new Date(stack.clock.now().getTime() + 3600_000).toISOString() },
      body: ['look at this'],
      media: [{ name: 'photo.png', url: `${FILES_HOST}/photo.png` }],
    });
    await sync();
    const row = await postByPage('p6-alt');
    const [asset] = await stack.db.db
      .select()
      .from(mediaAsset)
      .where(eq(mediaAsset.postId, row.id));
    expect(asset!.altText).toBe('A simple test image with a single colour.');
    const call = ai.calls.find((c) => c.req.purpose === 'alt_text')!;
    expect(call.req.image?.mimeType).toBe('image/png');
    expect(call.req.image?.base64.length).toBeGreaterThan(0);
    // Rendered media carries the generated description instead of the file name.
    const { enrichRenderedMedia } = await import('../../src/modules/media/media.service.js');
    const rendered = enrichRenderedMedia(
      {
        text: 't',
        media: [{ assetId: asset!.id, mimeType: 'image/png', byteSize: 0, alt: 'photo.png' }],
      },
      new Map([[asset!.id, asset!]]),
      'linkedin',
    );
    expect(rendered.media[0]!.alt).toBe('A simple test image with a single colour.');
    // A second sync does not regenerate.
    const n = ai.calls.filter((c) => c.req.purpose === 'alt_text').length;
    fake.notion.upsert('p6-alt', { body: ['look at this again'] });
    await sync();
    expect(ai.calls.filter((c) => c.req.purpose === 'alt_text').length).toBe(n);
  });

  it('never schedules AI-assisted content by itself and applies the approval policy to it', async () => {
    const me = await inject('GET', '/v1/me');
    const myId = me.json<{ user: { id: string } }>().user.id;
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, {
      approval: { required: true, reviewers: [myId] },
    });
    fake.notion.upsert('p6-var', {
      status: 'Scheduled',
      publishDate: { start: new Date(stack.clock.now().getTime() + 3600_000).toISOString() },
    });
    await sync();
    const row = await postByPage('p6-var');
    expect(row.aiAssisted).toBe(true);
    expect(
      (row.validationErrors as { code: string }[] | null)?.some(
        (e) => e.code === 'APPROVAL_REQUIRED',
      ),
    ).toBe(true);
    expect(
      await stack.db.db.select().from(publication).where(eq(publication.postId, row.id)),
    ).toHaveLength(0);
    const list = await inject('GET', `/v1/workspaces/${workspaceId}/posts`);
    const dto = list
      .json<{ posts: { id: string; aiAssisted: boolean }[] }>()
      .posts.find((p) => p.id === row.id)!;
    expect(dto.aiAssisted).toBe(true);
    await inject('PATCH', `/v1/workspaces/${workspaceId}`, { approval: null });
    const usage = await inject('GET', `/v1/workspaces/${workspaceId}/ai`);
    const body = usage.json<{
      usage: { generations: number; usedTokens: number; costUsd: number };
      recent: { purpose: string }[];
    }>();
    expect(body.usage.generations).toBeGreaterThanOrEqual(5);
    expect(body.usage.usedTokens).toBeGreaterThan(0);
    expect(body.recent[0]!.purpose).toBeDefined();
  });
});
