import { describe, expect, it } from 'vitest';
import { createProviderRegistry, UnknownProviderError } from './registry.js';
import { FakeProvider } from './providers/fake/fake-provider.js';

describe('provider registry', () => {
  it('resolves registered providers and rejects unknown ones', () => {
    const reg = createProviderRegistry([new FakeProvider()]);
    expect(reg.has('fake')).toBe(true);
    expect(reg.get('fake').id).toBe('fake');
    expect(reg.ids()).toEqual(['fake']);
    expect(() => reg.get('linkedin')).toThrow(UnknownProviderError);
  });

  it('rejects duplicate registrations', () => {
    expect(() => createProviderRegistry([new FakeProvider(), new FakeProvider()])).toThrow(
      /Duplicate/,
    );
  });
});
