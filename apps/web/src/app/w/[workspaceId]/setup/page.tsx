import { redirect } from 'next/navigation';
import { completeSetup } from '@/app/actions';
import { Shell } from '@/components/shell';
import { Button, Card, Input, Notice, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { loadWorkspace } from '@/lib/workspace';

interface Option {
  id: string;
  title: string;
  url: string;
}

/** Setup wizard after "Connect with Notion": create the template in a page, or adopt an existing database. */
export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ source?: string; error?: string }>;
}) {
  const { workspaceId } = await params;
  const { source, error } = await searchParams;
  const { me, membership, canManage } = await loadWorkspace(workspaceId, `/w/${workspaceId}/setup`);
  if (!canManage) redirect(`/w/${workspaceId}/connections`);
  if (!source) redirect(`/w/${workspaceId}/connections`);

  let options: {
    pages: Option[];
    databases: Option[];
    suggested: {
      contentDatabaseId: string;
      campaignsDatabaseId: string | null;
      ideasDatabaseId: string | null;
    } | null;
  } | null = null;
  let loadError: string | null = null;
  try {
    options = await api(`/v1/workspaces/${workspaceId}/content-sources/${source}/setup`);
  } catch (err) {
    loadError = errorMessage(err);
  }
  const action = completeSetup.bind(null, workspaceId, source);

  return (
    <Shell
      email={me.user.email}
      workspace={{ id: workspaceId, name: membership.name, role: membership.role }}
    >
      <h1 className="text-xl font-semibold">Set up Notion</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {loadError && <Notice kind="error">{loadError}</Notice>}
      {options?.suggested && (
        <Card title="Connect the duplicated Postelyo template">
          <p className="mb-3 text-sm text-[var(--muted)]">
            We found the databases of the Postelyo template in your Notion workspace
            {options.suggested.campaignsDatabaseId ? ', including Campaigns' : ''}
            {options.suggested.ideasDatabaseId ? ' and Ideas' : ''}. Connect them in one step; the
            calendar and board views come with the template.
          </p>
          <form action={action}>
            <input type="hidden" name="mode" value="existing" />
            <input type="hidden" name="databaseId" value={options.suggested.contentDatabaseId} />
            {options.suggested.ideasDatabaseId && (
              <input
                type="hidden"
                name="ideasDatabaseId"
                value={options.suggested.ideasDatabaseId}
              />
            )}
            <Button>Connect the template</Button>
          </form>
        </Card>
      )}
      {options && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Create the content database">
            <p className="mb-3 text-sm text-[var(--muted)]">
              Postelyo creates the content database plus Campaigns and Ideas under a page you shared
              with it. Views (calendar, board) must be added by hand; the duplicated template ships
              them ready-made.
            </p>
            {options.pages.length === 0 ? (
              <Notice kind="info">
                No pages were shared. Reconnect and pick at least one page.
              </Notice>
            ) : (
              <form action={action} className="space-y-3">
                <input type="hidden" name="mode" value="create" />
                <Select
                  name="parentPageId"
                  label="Parent page"
                  options={options.pages.map((p) => ({ value: p.id, label: p.title }))}
                />
                <Input name="title" label="Database name" defaultValue="Postelyo Content" />
                <Button>Create and connect</Button>
              </form>
            )}
          </Card>
          <Card title="Use an existing database">
            <p className="mb-3 text-sm text-[var(--muted)]">
              It must match the Postelyo template; validation tells you what is missing.
            </p>
            {options.databases.length === 0 ? (
              <Notice kind="info">No databases were shared.</Notice>
            ) : (
              <form action={action} className="space-y-3">
                <input type="hidden" name="mode" value="existing" />
                <Select
                  name="databaseId"
                  label="Database"
                  options={options.databases.map((d) => ({ value: d.id, label: d.title }))}
                />
                <Button variant="secondary">Validate and connect</Button>
              </form>
            )}
          </Card>
        </div>
      )}
    </Shell>
  );
}
