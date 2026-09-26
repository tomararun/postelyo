/**
 * Minimal HTML templating with automatic escaping (security.md §8). Values
 * interpolated into `html` are escaped unless wrapped with `raw()`.
 */

export class RawHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

type Interpolated = string | number | boolean | null | undefined | RawHtml | Interpolated[];

function render(v: Interpolated): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof RawHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: Interpolated[]): RawHtml {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new RawHtml(out);
}

export function layout(title: string, body: RawHtml): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Postelyo</title>
        <style>
          :root {
            color-scheme: light dark;
            font-family: system-ui, sans-serif;
          }
          body {
            max-width: 40rem;
            margin: 3rem auto;
            padding: 0 1rem;
            line-height: 1.5;
          }
          header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 2rem;
          }
          label {
            display: block;
            margin: 1rem 0 0.25rem;
          }
          input,
          button {
            font: inherit;
            padding: 0.5rem 0.75rem;
          }
          .notice {
            padding: 0.75rem 1rem;
            border-left: 4px solid #4a7;
            background: rgba(68, 170, 119, 0.1);
          }
          .error {
            border-color: #c44;
            background: rgba(204, 68, 68, 0.1);
          }
          table {
            border-collapse: collapse;
            width: 100%;
          }
          td,
          th {
            text-align: left;
            padding: 0.4rem 0.5rem;
            border-bottom: 1px solid rgba(128, 128, 128, 0.3);
          }
          form.inline {
            display: inline;
          }
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>`.value;
}
