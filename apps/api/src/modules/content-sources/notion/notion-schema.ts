import type { NotionDatabase } from './notion-client.js';

/**
 * The Notion content database contract (product-requirements.md §4.4, §4.5).
 * Validation runs when a database is connected and reports exactly what to fix.
 */

export interface ContractProperty {
  name: string;
  types: readonly string[];
  required: boolean;
  /** Owner of the column: user-edited or system-written. */
  owner: 'user' | 'system';
  requiredOptions?: readonly string[];
  recommendedOptions?: readonly string[];
  /** Optional property whose absence is not even a warning (newer, additive columns). */
  silent?: boolean;
}

export const NOTION_CONTRACT: readonly ContractProperty[] = [
  { name: 'Name', types: ['title'], required: true, owner: 'user' },
  {
    // `select` is accepted too: Notion's API cannot create `status` properties, so the
    // generated template uses a select with the same options.
    name: 'Status',
    types: ['status', 'select'],
    required: true,
    owner: 'user',
    requiredOptions: ['Draft', 'Ready', 'Scheduled', 'Cancelled'],
    recommendedOptions: ['Idea', 'In review', 'Changes requested'],
  },
  { name: 'Publish Date', types: ['date'], required: true, owner: 'user' },
  {
    name: 'Platforms',
    types: ['multi_select'],
    required: true,
    owner: 'user',
    requiredOptions: ['LinkedIn'],
    // Additive: Phase 1 adds LinkedIn Pages; Phase 2 adds X, Facebook Pages and Instagram.
    recommendedOptions: ['LinkedIn Page', 'X', 'Facebook Page', 'Instagram'],
  },
  { name: 'Post Text', types: ['rich_text'], required: false, owner: 'user' },
  { name: 'Media', types: ['files'], required: false, owner: 'user' },
  { name: 'Time Zone', types: ['select', 'rich_text'], required: false, owner: 'user' },
  // Phase 2: optional per-platform text overrides; the body is used when empty.
  { name: 'LinkedIn Text', types: ['rich_text'], required: false, owner: 'user', silent: true },
  { name: 'X Text', types: ['rich_text'], required: false, owner: 'user', silent: true },
  { name: 'Facebook Text', types: ['rich_text'], required: false, owner: 'user', silent: true },
  { name: 'Instagram Caption', types: ['rich_text'], required: false, owner: 'user', silent: true },
  // Phase 4 (template v2): every addition is optional and silent so v1 databases keep validating.
  { name: 'Campaign', types: ['relation'], required: false, owner: 'user', silent: true },
  { name: 'Repeat', types: ['select', 'status'], required: false, owner: 'user', silent: true },
  { name: 'Repeat Until', types: ['date'], required: false, owner: 'user', silent: true },
  { name: 'First Comment', types: ['rich_text'], required: false, owner: 'user', silent: true },
  { name: 'Repeat Of', types: ['relation'], required: false, owner: 'system', silent: true },
  { name: 'Approval', types: ['select'], required: false, owner: 'system', silent: true },
  { name: 'Link Report', types: ['rich_text'], required: false, owner: 'system', silent: true },
  // System-owned select options are created on write, so only the property must exist.
  { name: 'Postelyo Status', types: ['select'], required: true, owner: 'system' },
  { name: 'Postelyo Note', types: ['rich_text'], required: true, owner: 'system' },
  { name: 'Published URL', types: ['url'], required: true, owner: 'system' },
  { name: 'Published At', types: ['date'], required: true, owner: 'system' },
  { name: 'Postelyo ID', types: ['rich_text'], required: true, owner: 'system' },
  // Phase 2: one link per platform when a page publishes to several; written only when present.
  { name: 'Published URLs', types: ['rich_text'], required: false, owner: 'system', silent: true },
];

/** Phase 4 companion database: campaigns. Only `Name` is required; summary columns are written when present. */
export const CAMPAIGN_CONTRACT: readonly ContractProperty[] = [
  { name: 'Name', types: ['title'], required: true, owner: 'user' },
  { name: 'Status', types: ['select', 'status'], required: false, owner: 'user', silent: true },
  { name: 'Start', types: ['date'], required: false, owner: 'user', silent: true },
  { name: 'End', types: ['date'], required: false, owner: 'user', silent: true },
  { name: 'Scheduled', types: ['number'], required: false, owner: 'system', silent: true },
  { name: 'Published', types: ['number'], required: false, owner: 'system', silent: true },
  { name: 'Failed', types: ['number'], required: false, owner: 'system', silent: true },
  { name: 'Next Publish', types: ['date'], required: false, owner: 'system', silent: true },
  {
    name: 'Postelyo Summary',
    types: ['rich_text'],
    required: false,
    owner: 'system',
    silent: true,
  },
];

/** Phase 4 companion database: ideas. `Status = Promote` triggers promotion to a draft post. */
export const IDEAS_CONTRACT: readonly ContractProperty[] = [
  { name: 'Name', types: ['title'], required: true, owner: 'user' },
  {
    name: 'Status',
    types: ['select', 'status'],
    required: true,
    owner: 'user',
    requiredOptions: ['Promote', 'Promoted'],
  },
  { name: 'Notes', types: ['rich_text'], required: false, owner: 'user', silent: true },
  { name: 'Platforms', types: ['multi_select'], required: false, owner: 'user', silent: true },
  { name: 'Post URL', types: ['url'], required: false, owner: 'system', silent: true },
];

export type SchemaIssueCode = 'MISSING_PROPERTY' | 'WRONG_TYPE' | 'MISSING_OPTION';

export interface SchemaIssue {
  code: SchemaIssueCode;
  property: string;
  message: string;
}

export interface SchemaValidation {
  ok: boolean;
  errors: SchemaIssue[];
  warnings: SchemaIssue[];
  /** Actual property names in the database keyed by contract name (case-insensitive match). */
  propertyMap: Record<string, string>;
}

const norm = (s: string) => s.trim().toLowerCase();

export function validateNotionDatabase(
  db: NotionDatabase,
  contract: readonly ContractProperty[] = NOTION_CONTRACT,
): SchemaValidation {
  const byNorm = new Map<string, { name: string; type: string; options: Set<string> }>();
  for (const p of Object.values(db.properties)) {
    byNorm.set(norm(p.name), {
      name: p.name,
      type: p.type,
      options: new Set((p.options ?? []).map((o) => norm(o.name))),
    });
  }

  const errors: SchemaIssue[] = [];
  const warnings: SchemaIssue[] = [];
  const propertyMap: Record<string, string> = {};

  for (const c of contract) {
    const found = byNorm.get(norm(c.name));
    if (!found) {
      if (c.silent) continue;
      (c.required ? errors : warnings).push({
        code: 'MISSING_PROPERTY',
        property: c.name,
        message: `${c.required ? 'Required' : 'Optional'} property "${c.name}" (${c.types.join(' or ')}) is missing`,
      });
      continue;
    }
    propertyMap[c.name] = found.name;
    if (!c.types.includes(found.type)) {
      errors.push({
        code: 'WRONG_TYPE',
        property: c.name,
        message: `Property "${found.name}" is of type ${found.type}; expected ${c.types.join(' or ')}`,
      });
      continue;
    }
    for (const opt of c.requiredOptions ?? []) {
      if (!found.options.has(norm(opt))) {
        errors.push({
          code: 'MISSING_OPTION',
          property: c.name,
          message: `Property "${found.name}" needs an option named "${opt}"`,
        });
      }
    }
    for (const opt of c.recommendedOptions ?? []) {
      if (!found.options.has(norm(opt))) {
        warnings.push({
          code: 'MISSING_OPTION',
          property: c.name,
          message: `Property "${found.name}" is missing the recommended option "${opt}"`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, propertyMap };
}

const HEX32 = /[0-9a-f]{32}/i;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a Notion database URL, a 32-hex id, or a dashed uuid; returns the dashed lowercase id. */
export function parseNotionDatabaseId(input: string): string | null {
  const s = input.trim();
  if (DASHED.test(s)) return s.toLowerCase();
  let candidate = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      // Database URLs look like /<workspace>/<Title>-<32hex>?v=<view>; the id is the last hex run in the path.
      const matches = u.pathname.match(/[0-9a-f]{32}/gi);
      candidate = matches?.[matches.length - 1] ?? '';
    } catch {
      return null;
    }
  }
  const m = candidate.match(HEX32);
  if (!m || candidate.replace(/-/g, '').length !== 32) return null;
  const h = m[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
