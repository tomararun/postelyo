import { describe, expect, it } from 'vitest';
import { ROLES, roleAtLeast } from './tenant-context.js';

describe('roleAtLeast', () => {
  it('orders owner > admin > editor > viewer', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    for (const r of ROLES) expect(roleAtLeast(r, 'viewer')).toBe(true);
  });
});
