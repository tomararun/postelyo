import { TINY_JPEG_320x240, TINY_PNG_1x1 } from '../../src/modules/media/test-images.js';
import { bodyToString, fakeFetch } from '../../src/shared/fetch-utils.js';

/**
 * Fake LinkedIn, Notion and file-hosting HTTP endpoints for integration tests.
 * Routes by URL and records requests so tests can assert on what left the
 * process. The Notion fake holds an in-memory database whose pages tests
 * mutate between syncs; Notion-hosted files get a fresh signed URL on every
 * read and reject stale signatures, like the real thing.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const NOTION_GOOD_DB = '1f2e3d4c5b6a47f8a9b0c1d2e3f40506';
export const NOTION_BROKEN_DB = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
export const NOTION_VALID_TOKEN = 'ntn_validtoken_0123456789abcdef';

/** Public image host served by the fake: /png, /jpg, /html (not an image), /huge (over the limit). */
export const FILES_HOST = 'https://files.example';
/** Notion-hosted files: signed URLs that expire when the page is re-read. */
export const NOTION_FILES_HOST = 'https://files.notion.example';

function notionProps(broken: boolean): Record<string, unknown> {
  const status = (opts: string[]) => ({
    type: 'status',
    status: { options: opts.map((name) => ({ name })), groups: [] },
  });
  const props: Record<string, unknown> = {
    Name: { id: 'title', type: 'title', title: {} },
    Status: status([
      'Idea',
      'Draft',
      'In review',
      'Changes requested',
      'Ready',
      'Scheduled',
      'Cancelled',
    ]),
    'Publish Date': { id: 'pd', type: 'date', date: {} },
    Platforms: {
      id: 'pl',
      type: 'multi_select',
      multi_select: {
        options: [
          { name: 'LinkedIn' },
          { name: 'LinkedIn Page' },
          { name: 'X' },
          { name: 'Facebook Page' },
          { name: 'Instagram' },
        ],
      },
    },
    'Post Text': { id: 'pt', type: 'rich_text', rich_text: {} },
    Media: { id: 'md', type: 'files', files: {} },
    'Postelyo Status': { id: 'ps', type: 'select', select: { options: [] } },
    'Postelyo Note': { id: 'pn', type: 'rich_text', rich_text: {} },
    'Published URL': { id: 'pu', type: 'url', url: {} },
    'Published At': { id: 'pa', type: 'date', date: {} },
    'Postelyo ID': { id: 'pi', type: 'rich_text', rich_text: {} },
    'Published URLs': { id: 'pus', type: 'rich_text', rich_text: {} },
    'X Text': { id: 'xt', type: 'rich_text', rich_text: {} },
    'Instagram Caption': { id: 'ic', type: 'rich_text', rich_text: {} },
  };
  if (broken) {
    delete props['Publish Date'];
    props['Postelyo Note'] = { id: 'pn', type: 'select', select: { options: [] } };
  }
  return props;
}

// ---------------------------------------------------------------------------
// Fake Notion pages
// ---------------------------------------------------------------------------

export interface FakeMediaInput {
  name: string;
  /** External link, or for Notion-hosted files the path served under NOTION_FILES_HOST. */
  url: string;
  kind?: 'external' | 'file';
}

export interface FakeNotionPageInput {
  title?: string;
  status?: string | null;
  publishDate?: { start: string; timeZone?: string | null } | null;
  platforms?: string[];
  postText?: string;
  body?: string[];
  media?: FakeMediaInput[];
  timeZone?: string | null;
  archived?: boolean;
  /** Per-platform text overrides keyed by Notion property name (e.g. 'X Text'). */
  platformText?: Record<string, string>;
  /** Phase 4: the database the page lives in; undefined = the content database. */
  databaseId?: string;
  campaignIds?: string[];
  repeat?: string | null;
  repeatUntil?: string | null;
  repeatOf?: string[];
  firstComment?: string;
  /** Phase 6 */
  generateVariants?: boolean;
  repurpose?: string | null;
  /** Phase 4: free-form property values for companion pages (campaigns, ideas). */
  extra?: Record<string, unknown>;
}

interface FakeNotionPage extends Required<
  Omit<
    FakeNotionPageInput,
    | 'publishDate'
    | 'status'
    | 'timeZone'
    | 'media'
    | 'platformText'
    | 'databaseId'
    | 'campaignIds'
    | 'repeat'
    | 'repeatUntil'
    | 'repeatOf'
    | 'firstComment'
    | 'generateVariants'
    | 'repurpose'
    | 'extra'
  >
> {
  id: string;
  status: string | null;
  publishDate: { start: string; timeZone?: string | null } | null;
  timeZone: string | null;
  media: FakeMediaInput[];
  platformText: Record<string, string>;
  databaseId: string | undefined;
  campaignIds: string[];
  repeat: string | null;
  repeatUntil: string | null;
  repeatOf: string[];
  firstComment: string;
  generateVariants: boolean;
  repurpose: string | null;
  extra: Record<string, unknown>;
  /** Block ids deleted through the API; indexes stay stable. */
  deletedBlocks: Set<number>;
  lastEditedTime: string;
  system: {
    postelyoStatus: string | null;
    postelyoNote: string;
    publishedUrl: string | null;
    publishedAt: string | null;
    postelyoId: string;
    publishedUrls: string;
    approval: string | null;
    linkReport: string;
  };
}

/** Plain text of a write-side rich_text array (`text.content`) or a read-side one (`plain_text`). */
function plainOf(v: unknown): string {
  return Array.isArray(v)
    ? v
        .map(
          (t) =>
            (t as { text?: { content?: string }; plain_text?: string }).text?.content ??
            (t as { plain_text?: string }).plain_text ??
            '',
        )
        .join('')
    : '';
}

const rt = (text: string) =>
  text.length === 0
    ? []
    : [
        {
          type: 'text',
          plain_text: text,
          href: null,
          annotations: { bold: false, italic: false },
          text: { content: text },
        },
      ];

export class FakeNotion {
  readonly pages = new Map<string, FakeNotionPage>();
  readonly patches: { pageId: string; properties: Record<string, unknown> }[] = [];
  /** Databases created through POST /v1/databases (template tool), keyed by dashed id. */
  readonly createdDatabases = new Map<string, Record<string, unknown>>();
  /** Current signature for Notion-hosted file URLs; bumps on every page read. */
  fileSig = 1;
  /** Phase 4: pages created through POST /v1/pages, in order. */
  readonly createdPages: string[] = [];
  private createdSeq = 0;
  private clock = Date.parse('2026-09-23T10:00:00.000Z');
  private seq = 0;

  /** Monotonic fake edit clock so `last_edited_time` ordering is deterministic. */
  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  upsert(id: string, input: FakeNotionPageInput): FakeNotionPage {
    const prev = this.pages.get(id);
    const page: FakeNotionPage = {
      id,
      title: input.title ?? prev?.title ?? `Page ${++this.seq}`,
      status: input.status !== undefined ? input.status : (prev?.status ?? 'Draft'),
      publishDate:
        input.publishDate !== undefined ? input.publishDate : (prev?.publishDate ?? null),
      platforms: input.platforms ?? prev?.platforms ?? ['LinkedIn'],
      postText: input.postText ?? prev?.postText ?? '',
      body: input.body ?? prev?.body ?? [],
      media: input.media ?? prev?.media ?? [],
      platformText: input.platformText ?? prev?.platformText ?? {},
      timeZone: input.timeZone !== undefined ? input.timeZone : (prev?.timeZone ?? null),
      archived: input.archived ?? prev?.archived ?? false,
      databaseId: input.databaseId ?? prev?.databaseId,
      campaignIds: input.campaignIds ?? prev?.campaignIds ?? [],
      repeat: input.repeat !== undefined ? input.repeat : (prev?.repeat ?? null),
      repeatUntil:
        input.repeatUntil !== undefined ? input.repeatUntil : (prev?.repeatUntil ?? null),
      repeatOf: input.repeatOf ?? prev?.repeatOf ?? [],
      firstComment: input.firstComment ?? prev?.firstComment ?? '',
      generateVariants: input.generateVariants ?? prev?.generateVariants ?? false,
      repurpose: input.repurpose !== undefined ? input.repurpose : (prev?.repurpose ?? null),
      extra: { ...(prev?.extra ?? {}), ...(input.extra ?? {}) },
      deletedBlocks: input.body !== undefined ? new Set() : (prev?.deletedBlocks ?? new Set()),
      lastEditedTime: this.tick(),
      system: prev?.system ?? {
        postelyoStatus: null,
        postelyoNote: '',
        publishedUrl: null,
        publishedAt: null,
        postelyoId: '',
        publishedUrls: '',
        approval: null,
        linkReport: '',
      },
    };
    this.pages.set(id, page);
    return page;
  }

  /** Live body texts of a page as the API would list them (deleted blocks excluded). */
  bodyOf(id: string): string[] {
    const p = this.pages.get(id);
    if (!p) return [];
    return p.body.filter((_, i) => !p.deletedBlocks.has(i));
  }

  /** Pages the API would return for a database query (Phase 4 companion databases are isolated). */
  private pagesIn(databaseId: string): FakeNotionPage[] {
    const kind = this.databaseKind(databaseId);
    return [...this.pages.values()].filter((p) =>
      kind === 'content'
        ? !p.databaseId || p.databaseId === databaseId
        : p.databaseId === databaseId,
    );
  }

  private databaseKind(databaseId: string): 'content' | 'campaigns' | 'ideas' | 'analytics' {
    const db = this.createdDatabases.get(databaseId) as
      { title?: { plain_text?: string }[] } | undefined;
    const title = (db?.title?.[0]?.plain_text ?? '').toLowerCase();
    if (title.includes('campaign')) return 'campaigns';
    if (title.includes('idea')) return 'ideas';
    if (title.includes('analytics')) return 'analytics';
    return 'content';
  }

  delete(id: string): void {
    this.pages.delete(id);
  }

  /** Signed URL for a Notion-hosted file path, valid until the next page read. */
  signedUrl(path: string): string {
    return `${NOTION_FILES_HOST}/${path.replace(/^\//, '')}?sig=${this.fileSig}&X-Amz-Expires=3600`;
  }

  private toApiPage(p: FakeNotionPage): Record<string, unknown> {
    const kind = p.databaseId ? this.databaseKind(p.databaseId) : 'content';
    if (kind === 'analytics') {
      const x = p.extra;
      const numberProp = (k: string) => ({
        type: 'number',
        number: typeof x[k] === 'number' ? x[k] : null,
      });
      return {
        object: 'page',
        id: p.id,
        url: `https://www.notion.so/${p.id.replace(/-/g, '')}`,
        archived: p.archived,
        in_trash: false,
        last_edited_time: p.lastEditedTime,
        properties: {
          Name: { type: 'title', title: rt(p.title) },
          Week: { type: 'date', date: typeof x['Week'] === 'string' ? { start: x['Week'] } : null },
          Platform: {
            type: 'select',
            select: typeof x['Platform'] === 'string' ? { name: x['Platform'] } : null,
          },
          Posts: numberProp('Posts'),
          Impressions: numberProp('Impressions'),
          Reach: numberProp('Reach'),
          Reactions: numberProp('Reactions'),
          Comments: numberProp('Comments'),
          Shares: numberProp('Shares'),
          Clicks: numberProp('Clicks'),
          Saves: numberProp('Saves'),
          'Engagement Rate': numberProp('Engagement Rate'),
          'Best Time': {
            type: 'rich_text',
            rich_text: rt(typeof x['Best Time'] === 'string' ? x['Best Time'] : ''),
          },
        },
      };
    }
    if (kind !== 'content') {
      const x = p.extra;
      return {
        object: 'page',
        id: p.id,
        url: `https://www.notion.so/${p.id.replace(/-/g, '')}`,
        archived: p.archived,
        in_trash: false,
        last_edited_time: p.lastEditedTime,
        properties: {
          Name: { type: 'title', title: rt(p.title) },
          Status: { type: 'select', select: p.status ? { name: p.status } : null },
          Notes: { type: 'rich_text', rich_text: rt(p.postText) },
          Platforms: { type: 'multi_select', multi_select: p.platforms.map((name) => ({ name })) },
          Start: { type: 'date', date: p.publishDate ? { start: p.publishDate.start } : null },
          End: { type: 'date', date: typeof x['end'] === 'string' ? { start: x['end'] } : null },
          Scheduled: { type: 'number', number: x['scheduled'] ?? null },
          Published: { type: 'number', number: x['published'] ?? null },
          Failed: { type: 'number', number: x['failed'] ?? null },
          'Next Publish': {
            type: 'date',
            date: typeof x['nextPublish'] === 'string' ? { start: x['nextPublish'] } : null,
          },
          'Postelyo Summary': {
            type: 'rich_text',
            rich_text: rt(typeof x['summary'] === 'string' ? x['summary'] : ''),
          },
          'Post URL': { type: 'url', url: (x['postUrl'] as string | undefined) ?? null },
        },
      };
    }
    return {
      object: 'page',
      id: p.id,
      url: `https://www.notion.so/${p.id.replace(/-/g, '')}`,
      archived: p.archived,
      in_trash: false,
      last_edited_time: p.lastEditedTime,
      properties: {
        Campaign: { type: 'relation', relation: p.campaignIds.map((id) => ({ id })) },
        Repeat: { type: 'select', select: p.repeat ? { name: p.repeat } : null },
        'Repeat Until': { type: 'date', date: p.repeatUntil ? { start: p.repeatUntil } : null },
        'Repeat Of': { type: 'relation', relation: p.repeatOf.map((id) => ({ id })) },
        'First Comment': { type: 'rich_text', rich_text: rt(p.firstComment) },
        'Generate variants': { type: 'checkbox', checkbox: p.generateVariants },
        Repurpose: { type: 'select', select: p.repurpose ? { name: p.repurpose } : null },
        Approval: {
          type: 'select',
          select: p.system.approval ? { name: p.system.approval } : null,
        },
        'Link Report': { type: 'rich_text', rich_text: rt(p.system.linkReport) },
        Name: { type: 'title', title: rt(p.title) },
        Status: { type: 'status', status: p.status ? { name: p.status } : null },
        'Publish Date': {
          type: 'date',
          date: p.publishDate
            ? { start: p.publishDate.start, end: null, time_zone: p.publishDate.timeZone ?? null }
            : null,
        },
        Platforms: { type: 'multi_select', multi_select: p.platforms.map((name) => ({ name })) },
        'Post Text': { type: 'rich_text', rich_text: rt(p.postText) },
        Media: {
          type: 'files',
          files: p.media.map((m) =>
            m.kind === 'file'
              ? {
                  name: m.name,
                  type: 'file',
                  file: { url: this.signedUrl(m.url), expiry_time: '2099-01-01T00:00:00.000Z' },
                }
              : { name: m.name, type: 'external', external: { url: m.url } },
          ),
        },
        'Time Zone': { type: 'select', select: p.timeZone ? { name: p.timeZone } : null },
        'Postelyo Status': {
          type: 'select',
          select: p.system.postelyoStatus ? { name: p.system.postelyoStatus } : null,
        },
        'Postelyo Note': { type: 'rich_text', rich_text: rt(p.system.postelyoNote) },
        'Published URL': { type: 'url', url: p.system.publishedUrl },
        'Published At': {
          type: 'date',
          date: p.system.publishedAt ? { start: p.system.publishedAt } : null,
        },
        'Postelyo ID': { type: 'rich_text', rich_text: rt(p.system.postelyoId) },
        'Published URLs': { type: 'rich_text', rich_text: rt(p.system.publishedUrls) },
        ...Object.fromEntries(
          Object.entries(p.platformText).map(([name, text]) => [
            name,
            { type: 'rich_text', rich_text: rt(text) },
          ]),
        ),
      },
    };
  }

  handle(url: string, method: string, body: string): Response | null {
    const u = new URL(url);
    if (u.hostname !== 'api.notion.com') return null;
    const path = u.pathname.replace(/^\/v1/, '');

    const query = path.match(/^\/databases\/([0-9a-f-]+)\/query$/);
    if (query && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as {
        filter?: { last_edited_time?: { on_or_after?: string } };
        start_cursor?: string;
        page_size?: number;
      };
      const since = parsed.filter?.last_edited_time?.on_or_after;
      const all = this.pagesIn(query[1]!)
        .filter((p) => !p.archived)
        .filter((p) => !since || p.lastEditedTime >= since)
        .sort((a, b) => a.lastEditedTime.localeCompare(b.lastEditedTime));
      const size = parsed.page_size ?? 100;
      const start = parsed.start_cursor ? Number(parsed.start_cursor) : 0;
      const slice = all.slice(start, start + size);
      const hasMore = start + size < all.length;
      // Every read hands out fresh signed URLs; previous ones expire.
      this.fileSig += 1;
      return json(200, {
        object: 'list',
        results: slice.map((p) => this.toApiPage(p)),
        has_more: hasMore,
        next_cursor: hasMore ? String(start + size) : null,
      });
    }

    if (path === '/search' && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as { filter?: { value?: string } };
      const kind = parsed.filter?.value ?? 'page';
      const results =
        kind === 'database'
          ? [
              ...[...this.createdDatabases.values()].map((d) => ({
                ...d,
                last_edited_time: '2026-09-26T00:00:00.000Z',
              })),
              {
                object: 'database',
                id: '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40506',
                url: 'https://www.notion.so/1f2e3d4c5b6a47f8a9b0c1d2e3f40506',
                title: [{ plain_text: 'Content Calendar' }],
                last_edited_time: '2026-09-25T00:00:00.000Z',
              },
            ]
          : [
              {
                object: 'page',
                id: '1f2e3d4c-5b6a-47f8-a9b0-c1d2e3f40507',
                url: 'https://www.notion.so/Marketing-1f2e3d4c5b6a47f8a9b0c1d2e3f40507',
                last_edited_time: '2026-09-25T00:00:00.000Z',
                properties: { title: { type: 'title', title: rt('Marketing') } },
              },
            ];
      return json(200, { object: 'list', results, has_more: false, next_cursor: null });
    }

    if (path === '/databases' && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as {
        parent?: { page_id?: string };
        title?: { text?: { content?: string } }[];
        properties?: Record<string, Record<string, unknown>>;
      };
      if (!parsed.parent?.page_id) {
        return json(400, {
          object: 'error',
          code: 'validation_error',
          message: 'parent.page_id required',
        });
      }
      const n = this.createdDatabases.size + 1;
      const id = `0000000${n}`.slice(-8) + '-0000-4000-8000-000000000000';
      // Echo the definition back the way Notion does: type + type-specific config with options.
      const properties: Record<string, unknown> = {};
      for (const [name, def] of Object.entries(parsed.properties ?? {})) {
        const type = Object.keys(def)[0] ?? 'unknown';
        properties[name] = { id: name, name, type, [type]: def[type] };
      }
      const created = {
        object: 'database',
        id,
        url: `https://www.notion.so/${id.replace(/-/g, '')}`,
        title: [{ plain_text: parsed.title?.[0]?.text?.content ?? 'Untitled' }],
        properties,
      };
      this.createdDatabases.set(id, created);
      return json(200, created);
    }

    const dbPatch = path.match(/^\/databases\/([0-9a-f-]+)$/);
    if (dbPatch && method === 'PATCH') {
      const db = this.createdDatabases.get(dbPatch[1]!) as
        { properties: Record<string, unknown> } | undefined;
      if (!db) return json(404, { object: 'error', code: 'object_not_found', message: 'no db' });
      const parsed = JSON.parse(body || '{}') as {
        properties?: Record<string, Record<string, unknown>>;
      };
      for (const [name, def] of Object.entries(parsed.properties ?? {})) {
        const type = Object.keys(def)[0] ?? 'unknown';
        db.properties[name] = { id: name, name, type, [type]: def[type] };
      }
      return json(200, db);
    }

    if (path === '/pages' && method === 'POST') {
      const parsed = JSON.parse(body || '{}') as {
        parent?: { database_id?: string };
        properties?: Record<string, Record<string, unknown>>;
        children?: Record<string, unknown>[];
      };
      const dbId = parsed.parent?.database_id;
      if (!dbId) return json(400, { object: 'error', code: 'validation_error', message: 'parent' });
      const id = `created-page-${++this.createdSeq}`;
      const input: FakeNotionPageInput = { databaseId: dbId, body: [] };
      this.applyProperties(input, parsed.properties ?? {});
      input.body = (parsed.children ?? []).map((c) =>
        plainOf((c[String(c['type'])] as Record<string, unknown>)?.['rich_text']),
      );
      const page = this.upsert(id, input);
      this.applySystemProperties(page, parsed.properties ?? {});
      this.createdPages.push(id);
      return json(200, this.toApiPage(page));
    }

    const blockDelete = path.match(/^\/blocks\/([0-9a-zA-Z-]+)-b(\d+)$/);
    if (blockDelete && method === 'DELETE') {
      const p = this.pages.get(blockDelete[1]!);
      if (!p) return json(404, { object: 'error', code: 'object_not_found', message: 'block' });
      p.deletedBlocks.add(Number(blockDelete[2]));
      p.lastEditedTime = this.tick();
      return json(200, { object: 'block', id: `${p.id}-b${blockDelete[2]}`, archived: true });
    }

    const childrenPatch = path.match(/^\/blocks\/([0-9a-zA-Z-]+)\/children$/);
    if (childrenPatch && method === 'PATCH') {
      const p = this.pages.get(childrenPatch[1]!);
      if (!p) return json(404, { object: 'error', code: 'object_not_found', message: 'block' });
      const parsed = JSON.parse(body || '{}') as { children?: Record<string, unknown>[] };
      for (const c of parsed.children ?? []) {
        p.body.push(plainOf((c[String(c['type'])] as Record<string, unknown>)?.['rich_text']));
      }
      p.lastEditedTime = this.tick();
      return json(200, { object: 'list', results: [] });
    }

    const blocks = this.handleBlocks(path, method);
    if (blocks) return blocks;

    const pageMatch = path.match(/^\/pages\/([0-9a-zA-Z-]+)$/);
    if (pageMatch) {
      const p = this.pages.get(pageMatch[1]!);
      if (!p)
        return json(404, {
          object: 'error',
          code: 'object_not_found',
          message: 'Could not find page',
        });
      if (method === 'GET') {
        this.fileSig += 1;
        return json(200, this.toApiPage(p));
      }
      if (method === 'PATCH') {
        const parsed = JSON.parse(body || '{}') as {
          properties?: Record<string, Record<string, unknown>>;
        };
        const props = parsed.properties ?? {};
        this.patches.push({ pageId: p.id, properties: props });
        const generic: FakeNotionPageInput = {};
        this.applyProperties(generic, props);
        if (generic.platformText) {
          generic.platformText = { ...p.platformText, ...generic.platformText };
        }
        if (generic.extra) generic.extra = { ...p.extra, ...generic.extra };
        Object.assign(
          p,
          Object.fromEntries(Object.entries(generic).filter(([, v]) => v !== undefined)),
        );
        this.applySystemProperties(p, props);
        p.lastEditedTime = this.tick();
        return json(200, this.toApiPage(p));
      }
    }

    return null;
  }

  /** System-owned columns written by Postelyo (writeback, AI notes), on create and patch. */
  private applySystemProperties(
    p: FakeNotionPage,
    props: Record<string, Record<string, unknown>>,
  ): void {
    {
      {
        for (const [name, value] of Object.entries(props)) {
          const plain = (v: unknown) =>
            Array.isArray(v)
              ? v.map((t) => (t as { text?: { content?: string } }).text?.content ?? '').join('')
              : '';
          switch (name) {
            case 'Approval':
              p.system.approval = (value['select'] as { name?: string } | null)?.name ?? null;
              break;
            case 'Link Report':
              p.system.linkReport = plain(value['rich_text']);
              break;
            case 'Postelyo Status':
              p.system.postelyoStatus = (value['select'] as { name?: string } | null)?.name ?? null;
              break;
            case 'Postelyo Note':
              p.system.postelyoNote = plain(value['rich_text']);
              break;
            case 'Postelyo ID':
              p.system.postelyoId = plain(value['rich_text']);
              break;
            case 'Published URL':
              p.system.publishedUrl = (value['url'] as string | null) ?? null;
              break;
            case 'Published At':
              p.system.publishedAt = (value['date'] as { start?: string } | null)?.start ?? null;
              break;
            case 'Published URLs':
              p.system.publishedUrls = plain(value['rich_text']);
              break;
          }
        }
      }
    }
  }

  private handleBlocks(path: string, method: string): Response | null {
    const children = path.match(/^\/blocks\/([0-9a-zA-Z-]+)\/children$/);
    if (children && method === 'GET') {
      const p = this.pages.get(children[1]!);
      if (!p)
        return json(404, {
          object: 'error',
          code: 'object_not_found',
          message: 'Could not find block',
        });
      return json(200, {
        object: 'list',
        results: p.body
          .map((text, i) => ({
            object: 'block',
            id: `${p.id}-b${i}`,
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: rt(text) },
          }))
          .filter((_, i) => !p.deletedBlocks.has(i)),
        has_more: false,
        next_cursor: null,
      });
    }

    return null;
  }

  /** Maps Notion property values (create/patch bodies) onto the fake page model. */
  private applyProperties(
    input: FakeNotionPageInput,
    props: Record<string, Record<string, unknown>>,
  ): void {
    const name = (v: unknown) => (v as { name?: string } | null)?.name ?? null;
    const ids = (v: unknown) =>
      Array.isArray(v)
        ? v.map((r) => (r as { id?: string }).id).filter((x): x is string => !!x)
        : [];
    for (const [key, value] of Object.entries(props)) {
      switch (key) {
        case 'Name':
          input.title = plainOf(value['title']);
          break;
        case 'Status':
          input.status = name(value['select'] ?? value['status']);
          break;
        case 'Publish Date':
        case 'Start': {
          const d = value['date'] as { start?: string; time_zone?: string | null } | null;
          input.publishDate = d?.start ? { start: d.start, timeZone: d.time_zone ?? null } : null;
          break;
        }
        case 'Platforms':
          input.platforms =
            (value['multi_select'] as { name: string }[] | undefined)?.map((o) => o.name) ?? [];
          break;
        case 'Post Text':
        case 'Notes':
          input.postText = plainOf(value['rich_text']);
          break;
        case 'Media':
          input.media = (
            (value['files'] as { name?: string; external?: { url: string } }[] | undefined) ?? []
          )
            .filter((f) => f.external?.url)
            .map((f) => ({
              name: f.name ?? 'file',
              url: f.external!.url,
              kind: 'external' as const,
            }));
          break;
        case 'Time Zone':
          input.timeZone = name(value['select']) ?? plainOf(value['rich_text']) ?? null;
          break;
        case 'Generate variants':
          input.generateVariants = value['checkbox'] === true;
          break;
        case 'Repurpose':
          input.repurpose = name(value['select']);
          break;
        case 'First Comment':
          input.firstComment = plainOf(value['rich_text']);
          break;
        case 'Repeat':
          input.repeat = name(value['select']);
          break;
        case 'Repeat Until':
          input.repeatUntil = (value['date'] as { start?: string } | null)?.start ?? null;
          break;
        case 'Repeat Of':
          input.repeatOf = ids(value['relation']);
          break;
        case 'Campaign':
          input.campaignIds = ids(value['relation']);
          break;
        case 'LinkedIn Text':
        case 'X Text':
        case 'Facebook Text':
        case 'Instagram Caption':
          input.platformText = {
            ...(input.platformText ?? {}),
            [key]: plainOf(value['rich_text']),
          };
          break;
        case 'Post URL':
          input.extra = { ...(input.extra ?? {}), postUrl: value['url'] ?? null };
          break;
        case 'Scheduled':
        case 'Published':
        case 'Failed':
          input.extra = { ...(input.extra ?? {}), [key.toLowerCase()]: value['number'] ?? null };
          break;
        case 'Next Publish':
          input.extra = {
            ...(input.extra ?? {}),
            nextPublish: (value['date'] as { start?: string } | null)?.start ?? null,
          };
          break;
        case 'Postelyo Summary':
          input.extra = { ...(input.extra ?? {}), summary: plainOf(value['rich_text']) };
          break;
        default: {
          // Phase 5: any other typed value is kept by property name (metric columns, analytics rows).
          const v =
            'number' in value
              ? value['number']
              : 'date' in value
                ? ((value['date'] as { start?: string } | null)?.start ?? null)
                : 'select' in value
                  ? name(value['select'])
                  : 'rich_text' in value
                    ? plainOf(value['rich_text'])
                    : undefined;
          if (v !== undefined) input.extra = { ...(input.extra ?? {}), [key]: v };
          break;
        }
      }
    }
  }

  /** Serves Notion-hosted file bytes; stale signatures get 403 like an expired S3 link. */
  handleFile(url: string): Response | null {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== NOTION_FILES_HOST) return null;
    if (u.searchParams.get('sig') !== String(this.fileSig)) {
      return new Response(
        '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
        {
          status: 403,
        },
      );
    }
    return imageResponse(u.pathname);
  }
}

/** Over the 8 MB limit: a PNG signature followed by zeros, so only the size check can reject it. */
const HUGE_PNG = (() => {
  const buf = new Uint8Array(9 * 1024 * 1024);
  buf.set(TINY_PNG_1x1, 0);
  return buf;
})();

function imageResponse(path: string): Response {
  // Specific fixtures first, then by extension.
  if (path.endsWith('/huge.png')) {
    return new Response(HUGE_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (path.endsWith('/gone.png')) return new Response('missing', { status: 404 });
  if (path.endsWith('.html')) {
    return new Response('<html>not an image</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
  if (path.endsWith('.png')) {
    return new Response(TINY_PNG_1x1, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
    return new Response(TINY_JPEG_320x240, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  return new Response('missing', { status: 404 });
}

// ---------------------------------------------------------------------------

export function createFakeProviders() {
  const requests: RecordedRequest[] = [];
  const notion = new FakeNotion();
  /** Phase 5: every provider metrics call. */
  const metricsCalls: { provider: string; url: string }[] = [];
  let userinfoStatus = 200;
  let imageInitStatus = 200;
  let organizationsStatus = 200;
  /** Pages the fake member administers; tests may replace the list. */
  let organizations: { id: string; name: string; vanity: string }[] = [
    { id: '1001', name: 'Acme Corp', vanity: 'acme' },
    { id: '1002', name: 'Acme Labs', vanity: 'acme-labs' },
  ];
  /** Elements returned by the Posts API author finder. */
  const recentPosts: Record<string, unknown>[] = [];
  const linkedInUploads: { url: string; byteLength: number }[] = [];
  /** Refresh tokens presented to the X token endpoint. */
  const xRefreshes: string[] = [];
  let metaPagesStatus = 200;
  const metaPages: Record<string, unknown>[] = [
    {
      id: 'page-1',
      name: 'Acme Page',
      access_token: 'PAGE-TOKEN-1',
      picture: { data: { url: 'https://media.example/page-1.jpg' } },
      instagram_business_account: {
        id: 'ig-1',
        username: 'acme',
        profile_picture_url: 'https://media.example/ig-1.jpg',
      },
    },
    { id: 'page-2', name: 'Other Page', access_token: 'PAGE-TOKEN-2' },
  ];

  const fetchImpl = fakeFetch((url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = bodyToString(init.body);
    const method = init.method ?? 'GET';
    requests.push({ url, method, headers, body });

    // --- LinkedIn OAuth ---
    if (url === 'https://www.linkedin.com/oauth/v2/accessToken') {
      const code = new URLSearchParams(body).get('code');
      if (code === 'good-code' || code === 'good-code-2' || code === 'good-code-org') {
        return json(200, {
          access_token: `AQV-access-${code}`,
          expires_in: 5184000,
          scope:
            code === 'good-code-org'
              ? 'openid,profile,r_organization_social,w_organization_social,rw_organization_admin'
              : 'openid,profile,w_member_social',
        });
      }
      return json(400, { error: 'invalid_grant', error_description: 'bad code' });
    }
    if (url === 'https://api.linkedin.com/v2/userinfo') {
      if (userinfoStatus !== 200) return json(userinfoStatus, {});
      const token = headers['authorization'] ?? '';
      const sub = token.includes('good-code-2') ? 'member-2' : 'member-1';
      return json(200, {
        sub,
        name: sub === 'member-1' ? 'Alice Example' : 'Bob Example',
        picture: `https://media.example/${sub}.jpg`,
      });
    }
    // --- LinkedIn organizations (Community Management API) ---
    if (url.startsWith('https://api.linkedin.com/rest/organizationAcls')) {
      if (organizationsStatus !== 200) return json(organizationsStatus, { message: 'no access' });
      return json(200, {
        elements: organizations.map((o) => ({
          organization: `urn:li:organization:${o.id}`,
          role: 'ADMINISTRATOR',
          state: 'APPROVED',
        })),
      });
    }
    if (url.startsWith('https://api.linkedin.com/rest/organizations?')) {
      const results: Record<string, unknown> = {};
      for (const o of organizations)
        results[o.id] = { localizedName: o.name, vanityName: o.vanity };
      return json(200, { results });
    }
    // --- LinkedIn post lookup (reconciliation) ---
    if (url.startsWith('https://api.linkedin.com/rest/posts?') && method === 'GET') {
      return json(200, { elements: recentPosts });
    }

    // --- LinkedIn publishing (used only when the real adapter runs) ---
    if (url === 'https://api.linkedin.com/rest/images?action=initializeUpload') {
      if (imageInitStatus !== 200) return json(imageInitStatus, { message: 'upload init failed' });
      const n = linkedInUploads.length + 1;
      return json(200, {
        value: { uploadUrl: `https://upload.linkedin.example/${n}`, image: `urn:li:image:IMG${n}` },
      });
    }
    if (url.startsWith('https://upload.linkedin.example/')) {
      linkedInUploads.push({
        url,
        byteLength: init.body instanceof Uint8Array ? init.body.byteLength : 0,
      });
      return new Response('', { status: 201 });
    }
    // --- LinkedIn metrics (Phase 5) ---
    if (url.startsWith('https://api.linkedin.com/rest/organizationalEntityShareStatistics')) {
      metricsCalls.push({ provider: 'linkedin', url });
      return json(200, {
        elements: [
          {
            totalShareStatistics: {
              impressionCount: 1200,
              uniqueImpressionsCount: 900,
              likeCount: 40,
              commentCount: 6,
              shareCount: 3,
              clickCount: 25,
            },
          },
        ],
      });
    }
    if (url.startsWith('https://api.linkedin.com/rest/socialActions/') && method === 'GET') {
      metricsCalls.push({ provider: 'linkedin', url });
      return json(200, {
        likesSummary: { totalLikes: 12 },
        commentsSummary: { totalFirstLevelComments: 2, aggregatedTotalComments: 3 },
      });
    }
    if (url === 'https://api.linkedin.com/rest/posts') {
      return new Response('', {
        status: 201,
        headers: { 'x-restli-id': `urn:li:share:${requests.length}` },
      });
    }

    // --- X OAuth 2.0 (PKCE) + identity ---
    if (url === 'https://api.x.com/2/oauth2/token') {
      const params = new URLSearchParams(body);
      if (!(headers['authorization'] ?? '').startsWith('Basic '))
        return json(401, { error: 'unauthorized_client' });
      if (params.get('grant_type') === 'refresh_token') {
        xRefreshes.push(params.get('refresh_token') ?? '');
        return json(200, {
          access_token: `XAT-refreshed-${xRefreshes.length}`,
          refresh_token: `XRT-${xRefreshes.length + 1}`,
          expires_in: 7200,
          scope: 'tweet.read tweet.write users.read media.write offline.access',
        });
      }
      if (params.get('code') === 'x-good' && params.get('code_verifier')) {
        return json(200, {
          access_token: 'XAT-1',
          refresh_token: 'XRT-1',
          expires_in: 7200,
          scope: 'tweet.read tweet.write users.read media.write offline.access',
        });
      }
      return json(400, { error: 'invalid_request', error_description: 'bad code' });
    }
    // --- X metrics (Phase 5) ---
    if (/^https:\/\/api\.x\.com\/2\/tweets\/[^/?]+\?/.test(url) && method === 'GET') {
      metricsCalls.push({ provider: 'x', url });
      return json(200, {
        data: {
          id: url.split('/tweets/')[1]!.split('?')[0],
          public_metrics: {
            retweet_count: 4,
            reply_count: 3,
            like_count: 30,
            quote_count: 1,
            bookmark_count: 2,
            impression_count: 2500,
          },
          non_public_metrics: { url_link_clicks: 40, user_profile_clicks: 7 },
        },
      });
    }
    if (url.startsWith('https://api.x.com/2/users/me')) {
      return json(200, {
        data: {
          id: 'x-user-1',
          username: 'alice',
          name: 'Alice X',
          profile_image_url: 'https://media.example/alice.jpg',
        },
      });
    }

    // --- Meta metrics (Phase 5) ---
    if (
      /^https:\/\/graph\.facebook\.com\/v21\.0\/[^/]+\/insights\?/.test(url) &&
      method === 'GET'
    ) {
      metricsCalls.push({ provider: 'meta', url });
      const metric = new URL(url).searchParams.get('metric') ?? '';
      if (metric.includes('post_impressions')) {
        return json(200, {
          data: [
            { name: 'post_impressions', values: [{ value: 800 }] },
            { name: 'post_impressions_unique', values: [{ value: 600 }] },
            { name: 'post_clicks', values: [{ value: 20 }] },
            { name: 'post_reactions_by_type_total', values: [{ value: { like: 15, love: 5 } }] },
          ],
        });
      }
      return json(200, {
        data: [
          { name: 'views', values: [{ value: 1500 }] },
          { name: 'reach', values: [{ value: 1100 }] },
          { name: 'likes', values: [{ value: 90 }] },
          { name: 'comments', values: [{ value: 8 }] },
          { name: 'shares', values: [{ value: 4 }] },
          { name: 'saved', values: [{ value: 11 }] },
        ],
      });
    }
    if (
      /^https:\/\/graph\.facebook\.com\/v21\.0\/[^/]+\?fields=shares/.test(url) &&
      method === 'GET'
    ) {
      return json(200, { shares: { count: 9 }, comments: { summary: { total_count: 5 } } });
    }

    // --- Meta (Facebook Login) ---
    if (url.startsWith('https://graph.facebook.com/v21.0/oauth/access_token')) {
      const q = new URL(url).searchParams;
      if (q.get('grant_type') === 'fb_exchange_token')
        return json(200, { access_token: 'META-LONG', expires_in: 5184000 });
      if (q.get('code') === 'meta-good')
        return json(200, { access_token: 'META-SHORT', expires_in: 3600 });
      return json(400, { error: { code: 100, message: 'Invalid verification code format.' } });
    }
    if (url.startsWith('https://graph.facebook.com/v21.0/me/accounts')) {
      if (metaPagesStatus !== 200)
        return json(metaPagesStatus, { error: { code: 200, message: 'Requires pages_show_list' } });
      return json(200, { data: metaPages });
    }

    // --- Notion public OAuth (Phase 3) ---
    if (url === 'https://api.notion.com/v1/oauth/token') {
      if (!(headers['authorization'] ?? '').startsWith('Basic '))
        return json(401, { error: 'unauthorized_client' });
      const parsed = JSON.parse(body || '{}') as { code?: string };
      if (parsed.code === 'notion-good') {
        return json(200, {
          access_token: NOTION_VALID_TOKEN,
          bot_id: 'bot-1',
          workspace_id: 'nws-1',
          workspace_name: 'Acme Notion',
          duplicated_template_id: null,
        });
      }
      return json(400, { error: 'invalid_grant', error_description: 'bad code' });
    }

    // --- Notion API ---
    if (url.startsWith('https://api.notion.com/')) {
      if (headers['authorization'] !== `Bearer ${NOTION_VALID_TOKEN}`) {
        return json(401, {
          object: 'error',
          code: 'unauthorized',
          message: 'API token is invalid.',
        });
      }
      const db = url.match(/^https:\/\/api\.notion\.com\/v1\/databases\/([0-9a-f-]+)$/);
      if (db && method === 'GET') {
        const created = notion.createdDatabases.get(db[1]!);
        if (created) return json(200, created);
        const id = db[1]!.replace(/-/g, '');
        if (id === NOTION_GOOD_DB) {
          return json(200, {
            object: 'database',
            id: db[1],
            title: [{ plain_text: 'Content Calendar' }],
            properties: notionProps(false),
          });
        }
        if (id === NOTION_BROKEN_DB) {
          return json(200, {
            object: 'database',
            id: db[1],
            title: [{ plain_text: 'Broken DB' }],
            properties: notionProps(true),
          });
        }
        return json(404, {
          object: 'error',
          code: 'object_not_found',
          message: 'Could not find database',
        });
      }
      const handled = notion.handle(url, method, body);
      if (handled) return handled;
    }

    // --- File hosts ---
    const notionFile = notion.handleFile(url);
    if (notionFile) return notionFile;
    if (url.startsWith(FILES_HOST + '/')) return imageResponse(new URL(url).pathname);

    return new Response('unexpected url ' + url, { status: 599 });
  });

  return {
    fetchImpl,
    requests,
    notion,
    metricsCalls,
    linkedInUploads,
    setUserinfoStatus: (s: number) => {
      userinfoStatus = s;
    },
    setImageInitStatus: (s: number) => {
      imageInitStatus = s;
    },
    setOrganizationsStatus: (s: number) => {
      organizationsStatus = s;
    },
    setOrganizations: (list: { id: string; name: string; vanity: string }[]) => {
      organizations = list;
    },
    recentPosts,
    xRefreshes,
    setMetaPagesStatus: (s: number) => {
      metaPagesStatus = s;
    },
  };
}
