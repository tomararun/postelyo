/** Local development only (D67): the sign-in link shown on screen because no email is sent. */
export function DevLinkNotice({ href }: { href: string }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-950">
      <p className="font-medium">Development mode: no email is sent.</p>
      <p className="mt-1 text-amber-900">
        Use the link the api just created. It works once and expires in 15 minutes.
      </p>
      <a
        href={href}
        className="mt-3 inline-flex h-9 items-center rounded-lg bg-amber-600 px-3.5 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
      >
        Open sign-in link
      </a>
    </div>
  );
}
