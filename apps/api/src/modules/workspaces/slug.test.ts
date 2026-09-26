import { describe, expect, it } from 'vitest';
import { slugSuffix, slugify, workspaceDefaultsFromEmail } from './slug.js';

describe('slugify', () => {
  it('normalises to url-safe lowercase', () => {
    expect(slugify('Acme Marketing!')).toBe('acme-marketing');
    expect(slugify('  Élan  Vital ')).toBe('elan-vital');
    expect(slugify('___')).toBe('workspace');
    expect(slugify('x'.repeat(100))).toHaveLength(40);
  });
});

describe('slugSuffix', () => {
  it('is six hex chars', () => {
    expect(slugSuffix()).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('workspaceDefaultsFromEmail', () => {
  it('derives a friendly name and slug base', () => {
    expect(workspaceDefaultsFromEmail('alex.smith@example.com')).toEqual({
      name: "Alex smith's workspace",
      slugBase: 'alex-smith',
    });
  });
});
