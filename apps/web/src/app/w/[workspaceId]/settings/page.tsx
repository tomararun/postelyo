import { deleteWorkspace, setWeeklyReport, updateWorkspace } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Button, Card, Input, Notice, QueryNotices } from '@/components/ui';
import { api } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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
  const members = (
    await api<{
      members: { userId: string; name: string; email: string; weeklyReport: boolean }[];
    }>(`/v1/workspaces/${workspaceId}/members`)
  ).members;
  const self = members.find((m) => m.userId === me.user.id);
  const slots = workspace.evergreen?.slots ?? [];
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
      {(membership.role === 'owner' || membership.role === 'admin') && (
        <Card title="Weekly report">
          <form action={setWeeklyReport.bind(null, workspaceId)} className="space-y-3">
            <Checkbox
              name="weeklyReport"
              label="Email me the weekly analytics report on Monday morning"
              checked={self?.weeklyReport !== false}
            />
            <Button>Save</Button>
          </form>
        </Card>
      )}
      <Card title="Links">
        <form action={action} className="space-y-3">
          <input type="hidden" name="linksForm" value="1" />
          <p className="text-sm text-[var(--muted)]">
            UTM parameters are added to links when a post is published; the Notion page is never
            changed. Use <code>{'{campaign}'}</code> and <code>{'{platform}'}</code> in the campaign
            field.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              name="utmSource"
              label="utm_source"
              defaultValue={workspace.links?.utm?.source ?? ''}
            />
            <Input
              name="utmMedium"
              label="utm_medium"
              defaultValue={workspace.links?.utm?.medium ?? ''}
            />
            <Input
              name="utmCampaign"
              label="utm_campaign"
              defaultValue={workspace.links?.utm?.campaign ?? ''}
              placeholder="{campaign}"
            />
          </div>
          <Checkbox
            name="shorten"
            label="Replace links with short tracked links (click counts on the publication page)"
            checked={workspace.links?.shorten === true}
          />
          {canManage && <Button>Save</Button>}
        </form>
      </Card>
      <Card title="Evergreen slots">
        <form action={action} className="space-y-3">
          <input type="hidden" name="evergreenForm" value="1" />
          <p className="text-sm text-[var(--muted)]">
            Pages with Repeat = Evergreen and Status = Ready are re-shared in these weekly slots
            (workspace time zone), never twice within the minimum gap.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-end gap-2">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Slot {i + 1}</span>
                  <select
                    name={`slot_${i}_weekday`}
                    defaultValue={slots[i] ? String(slots[i].weekday) : ''}
                    className="rounded-md border border-[var(--border)] bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="">—</option>
                    {WEEKDAYS.map((d, idx) => (
                      <option key={d} value={idx + 1}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  name={`slot_${i}_time`}
                  label="Time (HH:MM)"
                  defaultValue={slots[i]?.time ?? ''}
                />
              </div>
            ))}
          </div>
          <Input
            name="minGapDays"
            label="Minimum days before the same page is re-shared"
            type="number"
            defaultValue={workspace.evergreen?.minGapDays ?? 30}
          />
          {canManage && <Button>Save</Button>}
        </form>
      </Card>
      <Card title="Approval policy">
        <form action={action} className="space-y-3">
          <input type="hidden" name="approvalForm" value="1" />
          <Checkbox
            name="approvalRequired"
            label="Require a reviewer's approval before a post can be scheduled"
            checked={workspace.approval?.required === true}
          />
          <p className="text-sm text-[var(--muted)]">Reviewers (owners always may approve):</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {members.map((m) => (
              <label key={m.userId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="reviewer"
                  value={m.userId}
                  defaultChecked={(workspace.approval?.reviewers ?? []).includes(m.userId)}
                />
                {m.name} <span className="text-xs text-[var(--muted)]">{m.email}</span>
              </label>
            ))}
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
