import { describe, expect, it } from 'vitest';
import { escapeHtml, html, layout, raw } from './html.js';

describe('html templating', () => {
  it('escapes interpolated values', () => {
    const out = html`<p>${'<script>alert("x")</script>'}</p>`.value;
    expect(out).toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  });

  it('passes raw and nested templates through unescaped', () => {
    const inner = html`<b>${'a&b'}</b>`;
    expect(html`<div>${inner}${raw('<i>ok</i>')}</div>`.value).toBe(
      '<div><b>a&amp;b</b><i>ok</i></div>',
    );
  });

  it('renders arrays and skips null/false', () => {
    const items = [1, 2].map((n) => html`<li>${n}</li>`);
    const out = html`<ul>
      ${items}${null}${false}
    </ul>`.value;
    expect(out.replace(/\s+/g, '')).toBe('<ul><li>1</li><li>2</li></ul>');
  });

  it('escapes the layout title', () => {
    expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
    expect(layout('<t>', html`x`)).toContain('<title>&lt;t&gt; · Postelyo</title>');
  });
});
