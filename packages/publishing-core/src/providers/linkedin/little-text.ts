import type { CanonicalContent, InlineNode } from '../../provider.js';

/**
 * LinkedIn "little text" rendering for the Posts API `commentary` field.
 *
 * Reserved characters must be escaped with a backslash; hashtags use the
 * `{hashtag|\#|word}` construct. Verify against LinkedIn's current docs before
 * the first live publish; this file is the only place that knows the format.
 */

const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const HASHTAG = /(^|[\s(])#([\p{L}\p{N}_]+)/gu;

export function escapeLittleText(s: string): string {
  return s.replace(RESERVED, (c) => `\\${c}`);
}

export function hashtagToken(word: string): string {
  return `{hashtag|\\#|${word.replace(/^#/, '')}}`;
}

/**
 * Inverse of the escaping for reconciliation: hashtag tokens back to `#word`,
 * backslash escapes removed. LinkedIn returns commentary in little-text form.
 */
export function unescapeLittleText(s: string): string {
  return s.replace(/\{hashtag\|\\#\|([^}]+)\}/g, '#$1').replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');
}

/** Escapes a text run while keeping `#word` hashtags as native tokens. */
export function renderTextRun(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    const start = m.index + m[1]!.length;
    out += escapeLittleText(text.slice(last, start));
    out += hashtagToken(m[2]!);
    last = start + 1 + m[2]!.length;
  }
  out += escapeLittleText(text.slice(last));
  return out;
}

function renderInlines(nodes: InlineNode[]): { text: string; plain: string } {
  let text = '';
  let plain = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
      case 'mention':
        text += renderTextRun(n.text);
        plain += n.text;
        break;
      case 'hashtag':
        text += hashtagToken(n.text);
        plain += n.text.startsWith('#') ? n.text : `#${n.text}`;
        break;
      case 'link': {
        const shown = n.text === n.href ? n.href : `${n.text}: ${n.href}`;
        text += escapeLittleText(shown);
        plain += shown;
        break;
      }
    }
  }
  return { text, plain };
}

export interface LittleText {
  /** Escaped commentary ready for the API. */
  text: string;
  /** Human-visible text, used for length validation and previews. */
  plainText: string;
}

export function renderLittleText(content: CanonicalContent): LittleText {
  const blocks = content.blocks.map((b) => {
    switch (b.type) {
      case 'paragraph':
        return renderInlines(b.inlines);
      case 'bulleted_list': {
        const items = b.items.map(renderInlines);
        return {
          text: items.map((i) => `• ${i.text}`).join('\n'),
          plain: items.map((i) => `• ${i.plain}`).join('\n'),
        };
      }
      case 'numbered_list': {
        const items = b.items.map(renderInlines);
        return {
          text: items.map((i, idx) => `${idx + 1}. ${i.text}`).join('\n'),
          plain: items.map((i, idx) => `${idx + 1}. ${i.plain}`).join('\n'),
        };
      }
    }
  });
  return {
    text: blocks
      .map((b) => b.text)
      .join('\n\n')
      .trim(),
    plainText: blocks
      .map((b) => b.plain)
      .join('\n\n')
      .trim(),
  };
}
