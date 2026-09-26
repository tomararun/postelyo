import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake-provider.js';
import { runProviderContractSuite } from '../../provider-contract.js';

runProviderContractSuite('FakeProvider', () => new FakeProvider());

describe('FakeProvider scripting', () => {
  const account = {
    id: 'acc',
    workspaceId: 'ws',
    provider: 'fake' as const,
    accountType: 'member' as const,
    providerAccountId: 'u1',
    displayName: 'Test',
  };
  const ctx = { credentials: { accessToken: 't' }, correlationId: 'c1', timeoutMs: 1000 };
  const input = { publicationId: 'pub1', account, content: { text: 'hi', media: [] } };

  it('replays scripted outcomes then succeeds', async () => {
    const p = new FakeProvider({
      script: [
        { kind: 'retryable_error', reason: '503' },
        { kind: 'terminal_error', reason: 'bad', code: 'content' },
      ],
    });
    expect((await p.publish(input, ctx)).kind).toBe('retryable_error');
    expect((await p.publish(input, ctx)).kind).toBe('terminal_error');
    expect((await p.publish(input, ctx)).kind).toBe('published');
    expect(p.calls).toHaveLength(3);
    expect(p.calls[0]?.correlationId).toBe('c1');
  });

  it('reports ambiguous when aborted', async () => {
    const p = new FakeProvider();
    const ac = new AbortController();
    ac.abort();
    const r = await p.publish(input, { ...ctx, signal: ac.signal });
    expect(r.kind).toBe('ambiguous');
  });
});
