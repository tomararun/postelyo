/**
 * Tenant context (architecture §4). Every service method that touches
 * tenant-owned data takes one; repositories scope queries by `workspaceId`.
 */

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/** True when `role` grants at least the privileges of `min` (security.md §4.1). */
export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export type Actor =
  | { type: 'user'; id: string; role: Role }
  | { type: 'system'; id: string }
  | { type: 'webhook'; id: string }
  | { type: 'api_key'; id: string };

export interface TenantContext {
  workspaceId: string;
  actor: Actor;
  correlationId: string;
}

/** Context for background jobs acting on a specific workspace. */
export function systemContext(
  workspaceId: string,
  jobName: string,
  correlationId: string,
): TenantContext {
  return { workspaceId, actor: { type: 'system', id: jobName }, correlationId };
}
