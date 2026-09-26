import { redirect } from 'next/navigation';
import { acceptInvitation } from '@/app/actions';
import { Button, Card, Notice } from '@/components/ui';
import { ApiError, api, getMe } from '@/lib/api';

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const me = await getMe();
  if (!me) redirect(`/sign-in?next=${encodeURIComponent(`/invitations/${token}`)}`);
  let info: { workspaceName: string; role: string; email: string } | null = null;
  try {
    info = await api(`/v1/invitations/${encodeURIComponent(token)}`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 410)) throw err;
  }
  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 px-4">
      <h1 className="text-2xl font-semibold">Workspace invitation</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {!info ? (
        <Notice kind="error">
          This invitation is invalid, expired or already used. Ask for a new one.
        </Notice>
      ) : (
        <Card>
          <p className="mb-4 text-sm">
            You are invited to join <strong>{info.workspaceName}</strong> as{' '}
            <strong>{info.role}</strong>. Signed in as {me.user.email}
            {me.user.email !== info.email && (
              <span className="text-[var(--muted)]">
                {' '}
                (the invitation was sent to {info.email})
              </span>
            )}
            .
          </p>
          <form action={acceptInvitation.bind(null, token)}>
            <Button>Accept invitation</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
