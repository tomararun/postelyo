import { redirect } from 'next/navigation';
import { ApiError, api, getMe } from '@/lib/api';

export interface WorkspaceDto {
  id: string;
  slug: string;
  name: string;
  defaultTimezone: string;
  defaultPublishTime: string;
  plan: string;
  dailyCapPerAccount: number;
  dailyCapIsDefault: boolean;
  notionWebhooks: boolean;
  providers: { linkedin: boolean; x: boolean; facebook: boolean; instagram: boolean };
  notificationEmail: string | null;
  alertCopyEmail: string | null;
  /** Phase 4 */
  links: {
    utm?: { source?: string; medium?: string; campaign?: string };
    shorten?: boolean;
  } | null;
  evergreen: { slots: { weekday: number; time: string }[]; minGapDays?: number } | null;
  approval: { required: boolean; reviewers: string[] } | null;
}

/** Signed-in user plus the workspace they are looking at; redirects to sign-in or 404s. */
export async function loadWorkspace(workspaceId: string, path: string) {
  const me = await getMe();
  if (!me) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  const membership = me.workspaces.find((w) => w.id === workspaceId);
  if (!membership) redirect('/?error=' + encodeURIComponent('Workspace not found.'));
  let workspace: WorkspaceDto;
  try {
    workspace = await api<WorkspaceDto>(`/v1/workspaces/${workspaceId}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) redirect('/');
    throw err;
  }
  return {
    me,
    membership,
    workspace,
    canManage: membership.role === 'owner' || membership.role === 'admin',
  };
}
