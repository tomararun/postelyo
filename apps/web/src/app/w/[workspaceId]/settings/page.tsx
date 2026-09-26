import { deleteWorkspace, updateWorkspace } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Button, Card, Input, Notice, QueryNotices } from '@/components/ui';
import { loadWorkspace } from '@/lib/workspace';

function Checkbox({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership, workspace, canManage } = await loadWorkspace(
    workspaceId,
    `/w/${workspaceId}/settings`,
  );
  const action = updateWorkspace.bind(null, workspaceId);
  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      {!canManage && <Notice kind="info">Only owners and admins can change settings.</Notice>}
      <Card title="Workspace">
        <form action={action} className="grid gap-3 sm:grid-cols-2">
          <Input name="name" label="Name" defaultValue={workspace.name} />
          <Input
            name="defaultTimezone"
            label="Default time zone (IANA)"
            defaultValue={workspace.defaultTimezone}
          />
          <Input
            name="defaultPublishTime"
            label="Default publish time (HH:MM)"
            defaultValue={workspace.defaultPublishTime}
          />
          <Input
            name="dailyCapPerAccount"
            label="Posts per account per day (blank = default)"
            type="number"
            defaultValue={workspace.dailyCapIsDefault ? '' : workspace.dailyCapPerAccount}
          />
          {canManage && (
            <div className="sm:col-span-2">
              <Button>Save</Button>
            </div>
          )}
        </form>
      </Card>
      <Card title="Platforms, webhooks and notifications">
        <form action={action} className="space-y-4">
          <input type="hidden" name="settingsForm" value="1" />
          <div className="grid gap-2 sm:grid-cols-3">
            <Checkbox name="provider_x" label="Enable X" checked={workspace.providers.x} />
            <Checkbox
              name="provider_facebook"
              label="Enable Facebook Pages"
              checked={workspace.providers.facebook}
            />
            <Checkbox
              name="provider_instagram"
              label="Enable Instagram"
              checked={workspace.providers.instagram}
            />
          </div>
          <Checkbox
            name="notionWebhooks"
            label="Process Notion webhooks (lower sync latency; polling stays on)"
            checked={workspace.notionWebhooks}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              name="notificationEmail"
              label="Account notices go to (blank = the admin who connected the account)"
              type="email"
              defaultValue={workspace.notificationEmail ?? ''}
            />
            <Input
              name="alertCopyEmail"
              label="Copy of operational alerts for this workspace (optional)"
              type="email"
              defaultValue={workspace.alertCopyEmail ?? ''}
            />
          </div>
          {canManage && <Button>Save</Button>}
        </form>
      </Card>
      {membership.role === 'owner' && (
        <Card title="Danger zone">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Deleting the workspace cancels scheduled posts immediately and permanently removes
            content, connections and tokens after a short delay. Type <strong>DELETE</strong> to
            confirm.
          </p>
          <form action={deleteWorkspace.bind(null, workspaceId)} className="flex items-end gap-3">
            <Input name="confirm" label="Confirmation" placeholder="DELETE" required />
            <Button variant="danger">Delete workspace</Button>
          </form>
        </Card>
      )}
    </Shell>
  );
}
