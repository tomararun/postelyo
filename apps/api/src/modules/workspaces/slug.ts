import { randomBytes } from 'node:crypto';

const MAX_BASE = 40;

/** URL-safe slug from free text; falls back to "workspace". */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BASE)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : 'workspace';
}

/** Short random suffix used when a slug collides. */
export function slugSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Default workspace name and slug base derived from a sign-in email. */
export function workspaceDefaultsFromEmail(email: string): { name: string; slugBase: string } {
  const local = email.split('@')[0] ?? 'workspace';
  const pretty = local.replace(/[._-]+/g, ' ').trim();
  const name =
    pretty.length > 0
      ? `${pretty.charAt(0).toUpperCase()}${pretty.slice(1)}'s workspace`
      : 'My workspace';
  return { name, slugBase: slugify(local) };
}
