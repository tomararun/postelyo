import { html, type RawHtml } from './html.js';

/** Shared page header with sign-out (server-rendered admin UI, architecture §2.4). */
export function pageHeader(email: string, workspaceId?: string): RawHtml {
  return html`<header>
    <h1><a href="/" style="text-decoration:none;color:inherit">Postelyo</a></h1>
    <nav>
      ${
        workspaceId
          ? html`<a href="/w/${workspaceId}/posts">Posts</a> ·
              <a href="/w/${workspaceId}/connections">Connections</a> ·`
          : null
      }
      <form class="inline" method="post" action="/sign-out">
        <span>${email}</span> <button type="submit">Sign out</button>
      </form>
    </nav>
  </header>`;
}

export function fmtDate(d: Date | null | undefined): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
}
