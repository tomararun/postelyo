import { describe, expect, it } from 'vitest';
import type { CanonicalContent } from '../posts/content.js';
import { contentToPlainText } from './render.js';

describe('contentToPlainText', () => {
  it('joins paragraphs with blank lines and renders lists', () => {
    const content: CanonicalContent = {
      v: 1,
      blocks: [
        {
          type: 'paragraph',
          inlines: [
            { t: 'text', text: 'We shipped ' },
            { t: 'text', text: 'Postelyo', marks: ['bold'] },
            { t: 'text', text: ' ' },
            { t: 'link', text: 'postelyo.com', href: 'https://postelyo.com' },
          ],
        },
        {
          type: 'bulleted_list',
          items: [[{ t: 'text', text: 'one' }], [{ t: 'text', text: 'two' }]],
        },
        { type: 'numbered_list', items: [[{ t: 'text', text: 'first' }]] },
        { type: 'paragraph', inlines: [{ t: 'hashtag', text: '#launch' }] },
      ],
      media: [],
      meta: { source: 'notion' },
    };
    expect(contentToPlainText(content)).toBe(
      'We shipped Postelyo postelyo.com https://postelyo.com\n\n• one\n• two\n\n1. first\n\n#launch',
    );
  });
});
