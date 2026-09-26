import { parseArgs } from 'node:util';
import { NotionApiError, NotionClient } from '../modules/content-sources/notion/notion-client.js';
import {
  parseNotionDatabaseId,
  validateNotionDatabase,
} from '../modules/content-sources/notion/notion-schema.js';
import {
  TEMPLATE_TITLE,
  templateCoversContract,
  templateCreateBody,
} from '../modules/content-sources/notion/notion-template.js';

export interface CreateTemplateInput {
  token: string;
  /** Page id or URL the database is created under; the integration must have access to it. */
  parentPage: string;
  title?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface CreateTemplateResult {
  databaseId: string;
  url: string;
  /** Validation of the database as Notion returned it; should be ok with no errors. */
  validation: ReturnType<typeof validateNotionDatabase>;
}

/**
 * Creates the Postelyo content database in the user's Notion workspace
 * (docs/notion-template.md) and validates it against the contract, so the
 * connect step will accept it without manual property fixes.
 */
export async function createNotionTemplate(
  input: CreateTemplateInput,
): Promise<CreateTemplateResult> {
  const missing = templateCoversContract();
  if (missing.length > 0)
    throw new Error(`template is missing contract properties: ${missing.join(', ')}`);
  const parentId = parseNotionDatabaseId(input.parentPage) ?? extractPageId(input.parentPage);
  if (!parentId) throw new Error('parent page must be a Notion page URL or a 32-character id');

  const client = new NotionClient(
    input.token,
    input.fetchImpl ? { fetchImpl: input.fetchImpl } : {},
  );
  const created = await client.createDatabase(
    templateCreateBody(parentId, input.title ?? TEMPLATE_TITLE),
  );
  const db = await client.retrieveDatabase(created.id);
  return { databaseId: created.id, url: created.url, validation: validateNotionDatabase(db) };
}

/** Page URLs look like /Title-<32hex>; accepts raw ids too. */
function extractPageId(input: string): string | null {
  const m = input.match(/[0-9a-f]{32}/i);
  if (!m) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      token: { type: 'string' },
      parent: { type: 'string' },
      title: { type: 'string' },
    },
  });
  const token = values.token ?? process.env['NOTION_TOKEN'];
  if (!token || !values.parent) {
    console.error(
      'Usage: npm run notion:template -- --parent <page url or id> [--token <ntn_...>] [--title "Postelyo Content"]\n' +
        'The integration token can also be provided as NOTION_TOKEN. Share the parent page with the integration first.',
    );
    process.exit(2);
  }
  try {
    const result = await createNotionTemplate({
      token,
      parentPage: values.parent,
      title: values.title,
    });
    console.log(`Created "${values.title ?? TEMPLATE_TITLE}"`);
    console.log(`  database id: ${result.databaseId}`);
    console.log(`  url:         ${result.url}`);
    if (result.validation.ok) console.log('  validation:  ok');
    else {
      console.log('  validation:  FAILED');
      for (const e of result.validation.errors) console.log(`    - ${e.message}`);
    }
    for (const w of result.validation.warnings) console.log(`  warning: ${w.message}`);
    console.log('\nNext: paste the token and this URL on the workspace Connections page.');
  } catch (err) {
    if (err instanceof NotionApiError) {
      console.error(`Notion error (${err.code}): ${err.message}`);
      if (err.code === 'not_found')
        console.error('Is the parent page shared with the integration?');
    } else {
      console.error((err as Error).message);
    }
    process.exit(1);
  }
}

if (process.argv[1] && /create-notion-template\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
