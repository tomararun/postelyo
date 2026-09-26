import { redirect } from 'next/navigation';
import { requestMagicLink } from '@/app/actions';
import { Button, Card, Input, Notice } from '@/components/ui';
import { getMe } from '@/lib/api';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string; next?: string }>;
}) {
  const { sent, error, next } = await searchParams;
  if (await getMe()) redirect(next && next.startsWith('/') ? next : '/');
  return (
    <div className="mx-auto mt-16 max-w-md space-y-4 px-4">
      <h1 className="text-2xl font-semibold">Sign in to Postelyo</h1>
      {sent && (
        <Notice kind="success">
          Check your inbox at <strong>{sent}</strong> for a sign-in link. It is valid for 15
          minutes.
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        <form action={requestMagicLink} className="space-y-4">
          <Input name="email" label="Email address" type="email" required />
          <input type="hidden" name="next" value={next ?? '/'} />
          <Button>Send sign-in link</Button>
        </form>
      </Card>
      <p className="text-xs text-[var(--muted)]">
        No password. A workspace is created on first sign-in.
      </p>
    </div>
  );
}
