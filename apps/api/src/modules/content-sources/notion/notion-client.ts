/**
 * Minimal Notion API client (architecture §2.2 "ContentSource: Notion").
 * Pure HTTP translator: no database access. `fetchImpl` is injectable for tests.
 *
 * Pinned to the 2022-06-28 API version, which exposes `databases/{id}` with a
 * flat `properties` map and `databases/{id}/query`. Moving to a newer version
 * is a change in this file only.
 */

export const NOTION_API_URL = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-28';

export type NotionErrorCode =
  'unauthorized' | 'not_found' | 'rate_limited' | 'invalid_request' | 'unavailable' | 'network';

export class NotionApiError extends Error {
  constructor(
    public readonly code: NotionErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export interface NotionPropertyOption {
  name: string;
}

export interface NotionProperty {
  id: string;
  name: string;
  type: string;
  /** Present for select / multi_select / status properties. */
  options?: NotionPropertyOption[];
}

export interface NotionDatabase {
  id: string;
  title: string;
  properties: Record<string, NotionProperty>;
}

/** A page as returned by the query endpoint; property values are raw Notion objects. */
export interface NotionPage {
  id: string;
  url: string;
  archived: boolean;
  lastEditedTime: string;
  properties: Record<string, Record<string, unknown>>;
}

export interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  /** The type-specific payload, e.g. `{ rich_text: [...] }`. */
  value: Record<string, unknown>;
}

export interface NotionSearchResult {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
}

export interface NotionPageList {
  pages: NotionPage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface NotionClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface QueryDatabaseInput {
  /** ISO timestamp; only pages edited on or after it are returned. */
  editedOnOrAfter?: string | undefined;
  startCursor?: string | null | undefined;
  pageSize?: number | undefined;
}

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    opts: NotionClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const json = await this.request('GET', `/databases/${encodeURIComponent(databaseId)}`);
    const props = asRecord(json['properties']);
    const properties: Record<string, NotionProperty> = {};
    for (const [name, raw] of Object.entries(props)) {
      const p = asRecord(raw);
      const type = typeof p['type'] === 'string' ? p['type'] : 'unknown';
      const typed = asRecord(p[type]);
      const rawOptions = typed['options'];
      const options = Array.isArray(rawOptions)
        ? rawOptions
            .map((o) => asRecord(o)['name'])
            .filter((n): n is string => typeof n === 'string')
            .map((n) => ({ name: n }))
        : undefined;
      properties[name] = {
        id: typeof p['id'] === 'string' ? p['id'] : name,
        name,
        type,
        ...(options ? { options } : {}),
      };
    }
    return {
      id: typeof json['id'] === 'string' ? json['id'] : databaseId,
      title: richTextToPlain(json['title']),
      properties,
    };
  }

  /** Pages ordered by last_edited_time ascending, optionally filtered by an edit watermark. */
  async queryDatabase(databaseId: string, input: QueryDatabaseInput = {}): Promise<NotionPageList> {
    const body: Record<string, unknown> = {
      page_size: input.pageSize ?? 100,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
    };
    if (input.editedOnOrAfter) {
      body['filter'] = {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: input.editedOnOrAfter },
      };
    }
    if (input.startCursor) body['start_cursor'] = input.startCursor;
    const json = await this.request(
      'POST',
      `/databases/${encodeURIComponent(databaseId)}/query`,
      body,
    );
    const results = Array.isArray(json['results']) ? json['results'] : [];
    return {
      pages: results.map((r) => toPage(asRecord(r))),
      hasMore: json['has_more'] === true,
      nextCursor: typeof json['next_cursor'] === 'string' ? json['next_cursor'] : null,
    };
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    return toPage(await this.request('GET', `/pages/${encodeURIComponent(pageId)}`));
  }

  /** All top-level blocks of a page (children of nested blocks are not expanded). */
  async retrieveBlockChildren(blockId: string, maxBlocks = 500): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ page_size: '100' });
      if (cursor) qs.set('start_cursor', cursor);
      const json = await this.request(
        'GET',
        `/blocks/${encodeURIComponent(blockId)}/children?${qs.toString()}`,
      );
      const results = Array.isArray(json['results']) ? json['results'] : [];
      for (const r of results) {
        const b = asRecord(r);
        const type = typeof b['type'] === 'string' ? b['type'] : 'unsupported';
        blocks.push({
          id: typeof b['id'] === 'string' ? b['id'] : '',
          type,
          hasChildren: b['has_children'] === true,
          value: asRecord(b[type]),
        });
      }
      cursor =
        json['has_more'] === true && typeof json['next_cursor'] === 'string'
          ? json['next_cursor']
          : null;
    } while (cursor && blocks.length < maxBlocks);
    return blocks;
  }

  /** Patches page properties (writeback). `properties` uses Notion's property value format. */
  async updatePageProperties(pageId: string, properties: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/pages/${encodeURIComponent(pageId)}`, { properties });
  }

  /**
   * Pages or databases the integration can see (setup wizard). Titles come from
   * the title property (pages) or the `title` array (databases).
   */
  async search(kind: 'page' | 'database', pageSize = 50): Promise<NotionSearchResult[]> {
    const json = await this.request('POST', '/search', {
      filter: { property: 'object', value: kind },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: pageSize,
    });
    const results = Array.isArray(json['results']) ? json['results'] : [];
    const out: NotionSearchResult[] = [];
    for (const raw of results) {
      const r = asRecord(raw);
      const id = typeof r['id'] === 'string' ? r['id'] : null;
      if (!id) continue;
      let title: string;
      if (kind === 'database') {
        title = richTextToPlain(r['title']);
      } else {
        const props = asRecord(r['properties']);
        const titleProp = Object.values(props)
          .map((p) => asRecord(p))
          .find((p) => p['type'] === 'title');
        title = titleProp ? richTextToPlain(titleProp['title']) : '';
      }
      out.push({
        id,
        title: title || 'Untitled',
        url: typeof r['url'] === 'string' ? r['url'] : '',
        lastEditedTime: typeof r['last_edited_time'] === 'string' ? r['last_edited_time'] : '',
      });
    }
    return out;
  }

  /** Creates a database under a page (template setup); returns id and URL. */
  async createDatabase(body: Record<string, unknown>): Promise<{ id: string; url: string }> {
    const json = await this.request('POST', '/databases', body);
    return {
      id: typeof json['id'] === 'string' ? json['id'] : '',
      url: typeof json['url'] === 'string' ? json['url'] : '',
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${NOTION_API_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'notion-version': NOTION_VERSION,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NotionApiError('network', `Notion request failed: ${(err as Error).message}`);
    }
    const json = parseJsonRecord(await res.text());
    if (res.ok) return json;

    const notionMessage = typeof json['message'] === 'string' ? json['message'] : res.statusText;
    switch (res.status) {
      case 401:
        throw new NotionApiError('unauthorized', 'Notion rejected the integration token', 401);
      case 403:
        throw new NotionApiError(
          'unauthorized',
          'The integration is not allowed to access this database',
          403,
        );
      case 404:
        throw new NotionApiError(
          'not_found',
          'Database not found. Check the id and share the database with the integration.',
          404,
        );
      case 429: {
        const ra = Number(res.headers.get('retry-after'));
        throw new NotionApiError(
          'rate_limited',
          'Notion rate limit reached',
          429,
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
        );
      }
      case 400:
        throw new NotionApiError(
          'invalid_request',
          `Notion rejected the request: ${notionMessage}`,
          400,
        );
      default:
        throw new NotionApiError(
          res.status >= 500 ? 'unavailable' : 'invalid_request',
          `Notion error ${res.status}: ${notionMessage}`,
          res.status,
        );
    }
  }
}

function toPage(p: Record<string, unknown>): NotionPage {
  const rawProps = asRecord(p['properties']);
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(rawProps)) properties[k] = asRecord(v);
  return {
    id: typeof p['id'] === 'string' ? p['id'] : '',
    url: typeof p['url'] === 'string' ? p['url'] : '',
    archived: p['archived'] === true || p['in_trash'] === true,
    lastEditedTime: typeof p['last_edited_time'] === 'string' ? p['last_edited_time'] : '',
    properties,
  };
}

function parseJsonRecord(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Notion rich text array → plain string. */
export function richTextToPlain(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v
    .map((t) => {
      const r = asRecord(t);
      return typeof r['plain_text'] === 'string' ? r['plain_text'] : '';
    })
    .join('');
}
