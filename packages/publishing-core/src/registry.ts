import type { ProviderId, PublishingProvider } from './provider.js';

export class UnknownProviderError extends Error {
  constructor(public readonly providerId: string) {
    super(`No publishing provider registered for '${providerId}'`);
    this.name = 'UnknownProviderError';
  }
}

export interface ProviderRegistry {
  get(id: ProviderId): PublishingProvider;
  has(id: ProviderId): boolean;
  ids(): ProviderId[];
}

export interface ProviderRegistryOptions {
  /**
   * Provider returned for ids that have no adapter registered. Used in
   * `PROVIDER_MODE=fake` so the whole pipeline runs against the FakeProvider
   * without any real network call.
   */
  fallback?: PublishingProvider;
}

/** Adding a platform = one adapter folder + one entry here (architecture §9.1). */
export function createProviderRegistry(
  providers: readonly PublishingProvider[],
  opts: ProviderRegistryOptions = {},
): ProviderRegistry {
  const byId = new Map<ProviderId, PublishingProvider>();
  for (const p of providers) {
    if (byId.has(p.id)) throw new Error(`Duplicate publishing provider '${p.id}'`);
    byId.set(p.id, p);
  }
  return {
    get(id) {
      const p = byId.get(id) ?? opts.fallback;
      if (!p) throw new UnknownProviderError(id);
      return p;
    },
    has: (id) => byId.has(id) || opts.fallback !== undefined,
    ids: () => [...byId.keys()],
  };
}
