import 'server-only';
import { headers } from 'next/headers';

/**
 * Server-side calls to the api process with the visitor's session cookie
 * forwarded (Phase 3). Everything the dashboard shows or changes goes through
 * the existing tenant-scoped `/v1` endpoints; nothing is duplicated here.
 */

export const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://localhost:3000';
export const APP_URL = process.env['APP_BASE_URL'] ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(typeof body['title'] === 'string' ? body['title'] : `API error ${status}`);
    this.name = 'ApiError';
  }
}

async function forwardHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const cookie = h.get('cookie');
  return {
    accept: 'application/json',
    origin: APP_URL,
    ...(cookie ? { cookie } : {}),
  };
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; allow?: number[] } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(await forwardHeaders()),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
    redirect: 'manual',
  });
  const json = parseJson(await res.text());
  if (!res.ok && !(init.allow ?? []).includes(res.status)) throw new ApiError(res.status, json);
  return json as T;
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface Me {
  user: { id: string; email: string; name: string };
  workspaces: {
    id: string;
    slug: string;
    name: string;
    role: 'owner' | 'admin' | 'editor' | 'viewer';
  }[];
}

/** Null when not signed in. */
export async function getMe(): Promise<Me | null> {
  try {
    return await api<Me>('/v1/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.body['issues'];
    const detail = Array.isArray(issues)
      ? issues
          .map((i) =>
            typeof i === 'object' && i && 'message' in i
              ? String((i as { message: unknown }).message)
              : '',
          )
          .filter(Boolean)
          .join(' ')
      : '';
    return detail ? `${err.message} ${detail}` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export const fmt = (d: string | null | undefined) =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
