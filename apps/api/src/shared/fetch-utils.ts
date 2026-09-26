/** Small helpers for code that wraps or fakes the Fetch API. */

export function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Best-effort string view of a request body for logging and test assertions. */
export function bodyToString(body: RequestInit['body']): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return '';
}

/** Builds a fetch-compatible function from a handler (tests). */
export function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(requestUrl(input), init ?? {});
}
