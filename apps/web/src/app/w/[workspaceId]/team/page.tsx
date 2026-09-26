import { invite, removeMember, revokeInvitation, setRole } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, QueryNotices, Select, Table } from '@/components/ui';
import { api, fmt } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

const ROLES = ['owner', 'admin', 'editor', 'viewer'];

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const q = await searchParams;
  const { me, membership, canManage } = await loadWorkspace(workspaceId, `/w/${workspaceId}/team`);
  const [members, invitations] = await Promise.all([
    api<{ members: Member[] }>(`/v1/workspaces/${workspaceId}/members`),
    canManage
      ? api<{ invitations: Invitation[] }>(`/v1/workspaces/${workspaceId}/invitations`)
      : Promise.resolve({ invitations: [] as Invitation[] }),
  ]);
  const grantable = membership.role === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="Members">
        <Table head={['Member', 'Role', 'Joined', '']}>
          {members.members.map((m) => {
            const self = m.userId === me.user.id;
            const editable = canManage && (m.role !== 'owner' || membership.role === 'owner');
            return (
              <tr key={m.userId}>
                <td className="py-2 pr-4">
                  {m.name} <span className="text-xs text-[var(--muted)]">{m.email}</span>
                  {self && <Badge>you</Badge>}
                </td>
                <td className="py-2 pr-4">
                  {editable ? (
                    <form
                      action={setRole.bind(null, workspaceId, m.userId)}
                      className="flex items-center gap-2"
                    >
                      <Select
                        name="role"
                        defaultValue={m.role}
                        options={grantable.map((r) => ({ value: r, label: r }))}
                      />
                      <Button variant="secondary">Save</Button>
                    </form>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                </td>
                <td className="py-2 pr-4">{fmt(m.joinedAt)}</td>
                <td className="py-2 text-right">
                  {(editable || self) && (
                    <form action={removeMember.bind(null, workspaceId, m.userId, self)}>
                      <Button variant="danger">{self ? 'Leave' : 'Remove'}</Button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      {canManage && (
        <>
          <Card title="Invite someone">
            <form action={invite.bind(null, workspaceId)} className="grid gap-3 sm:grid-cols-3">
              <Input name="email" label="Email" type="email" required />
              <Select
                name="role"
                label="Role"
                defaultValue="editor"
                options={grantable.map((r) => ({ value: r, label: r }))}
              />
              <div className="flex items-end">
                <Button>Send invitation</Button>
              </div>
            </form>
          </Card>
          <Card title="Invitations">
            {invitations.invitations.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No invitations yet.</p>
            ) : (
              <Table head={['Email', 'Role', 'Status', 'Expires', '']}>
                {invitations.invitations.map((i) => {
                  const state = i.acceptedAt
                    ? 'accepted'
                    : i.revokedAt
                      ? 'revoked'
                      : new Date(i.expiresAt) < new Date()
                        ? 'expired'
                        : 'open';
                  return (
                    <tr key={i.id}>
                      <td className="py-2 pr-4">{i.email}</td>
                      <td className="py-2 pr-4">{i.role}</td>
                      <td className="py-2 pr-4">
                        <Badge
                          tone={
                            state === 'open'
                              ? 'warning'
                              : state === 'accepted'
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {state}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">{fmt(i.expiresAt)}</td>
                      <td className="py-2 text-right">
                        {state === 'open' && (
                          <form action={revokeInvitation.bind(null, workspaceId, i.id)}>
                            <Button variant="danger">Revoke</Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}
