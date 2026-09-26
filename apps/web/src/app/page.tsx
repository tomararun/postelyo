import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createWorkspace } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Badge, Button, Card, Input, QueryNotices, Table } from '@/components/ui';
import { getMe } from '@/lib/api';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  const q = await searchParams;
  return (
    <Shell email={me.user.email}>
      <QueryNotices notice={q.notice} error={q.error} />
      <Card title="Your workspaces">
        <Table head={['Name', 'Role', '']}>
          {me.workspaces.map((w) => (
            <tr key={w.id}>
              <td className="py-2 pr-4">
                <Link href={`/w/${w.id}/posts`} className="font-medium hover:underline">
                  {w.name}
                </Link>
                <div className="text-xs text-[var(--muted)]">{w.slug}</div>
              </td>
              <td className="py-2 pr-4">
                <Badge>{w.role}</Badge>
              </td>
              <td className="py-2 text-right">
                <Button variant="link" href={`/w/${w.id}/connections`}>
                  Open
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Create a workspace">
        <form action={createWorkspace} className="grid gap-3 sm:grid-cols-3">
          <Input name="name" label="Name" required placeholder="Acme Marketing" />
          <Input name="defaultTimezone" label="Default time zone (IANA)" defaultValue="UTC" />
          <div className="flex items-end">
            <Button>Create</Button>
          </div>
        </form>
      </Card>
    </Shell>
  );
}
