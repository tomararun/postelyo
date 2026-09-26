import { describe, expect, it } from 'vitest';
import type { CanonicalContent } from '../../provider.js';
import {
  escapeLittleText,
  renderLittleText,
  renderTextRun,
  unescapeLittleText,
} from './little-text.js';

describe('little text escaping', () => {
  it('unescapes what it escaped, including hashtag tokens (reconciliation round trip)', () => {
    const original = 'Shipping #launch today (finally) a|b{c} #SaaS_v2 \\ done';
    expect(unescapeLittleText(renderTextRun(original))).toBe(original);
  });

  it('escapes every reserved character', () => {
    expect(escapeLittleText('a|b{c}d@e[f]g(h)i<j>k#l*m_n~o\\p')).toBe(
      'a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\*m\\_n\\~o\\\\p',
    );
    expect(escapeLittleText('plain text, no reserved chars!')).toBe(
      'plain text, no reserved chars!',
    );
  });

  it('turns hashtags into native tokens while escaping the rest', () => {
    expect(renderTextRun('Shipping #launch today (finally) #SaaS_v2')).toBe(
      'Shipping {hashtag|\\#|launch} today \\(finally\\) {hashtag|\\#|SaaS_v2}',
    );
    expect(renderTextRun('#first word')).toBe('{hashtag|\\#|first} word');
    expect(renderTextRun('not#a#tag')).toBe('not\\#a\\#tag');
  });
});

describe('renderLittleText', () => {
  it('renders paragraphs, lists, links and mentions with plain text alongside', () => {
    const content: CanonicalContent = {
      v: 1,
      blocks: [
        {
          type: 'paragraph',
          inlines: [
            { t: 'text', text: 'Hello ', marks: ['bold'] },
            { t: 'link', text: 'Postelyo', href: 'https://postelyo.com/a_b' },
            { t: 'text', text: ' #launch' },
          ],
        },
        {
          type: 'bulleted_list',
          items: [[{ t: 'text', text: 'one (1)' }], [{ t: 'mention', text: '@alice' }]],
        },
        { type: 'numbered_list', items: [[{ t: 'hashtag', text: 'tag' }]] },
      ],
      media: [],
      meta: { source: 'notion' },
    };
    const r = renderLittleText(content);
    expect(r.text).toBe(
      'Hello Postelyo: https://postelyo.com/a\\_b {hashtag|\\#|launch}\n\n• one \\(1\\)\n• \\@alice\n\n1. {hashtag|\\#|tag}',
    );
    expect(r.plainText).toBe(
      'Hello Postelyo: https://postelyo.com/a_b #launch\n\n• one (1)\n• @alice\n\n1. #tag',
    );
  });
});
