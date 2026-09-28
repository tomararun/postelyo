import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Phase 7: a fetch that sends every request through an HTTP(S) proxy
 * (`MEDIA_EGRESS_PROXY_URL`). Customers who allow-list Postelyo's address for
 * media downloads get one stable egress IP regardless of where the worker
 * runs. The SSRF guard in the media fetcher still applies before the request.
 */
export function proxiedFetch(proxyUrl: string): typeof fetch {
  const dispatcher = new ProxyAgent(proxyUrl);
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const res = await undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
    return res;
  };
  return impl;
}
