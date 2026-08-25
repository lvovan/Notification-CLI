/**
 * Host-neutral HTTP shapes.
 *
 * Handlers in this package are shared by two hosts: the Azure Functions app in
 * `apps/api` and the App Service server in `apps/server`. The types below are
 * deliberately the intersection of what both can provide, and are structurally
 * satisfied by the `HttpRequest` and `HttpResponseInit` types of
 * `@azure/functions`, so the Functions adapter needs no wrapping at all.
 */

/** The subset of request headers a handler is allowed to depend on. */
export interface CoreHeaders {
  get(name: string): string | null;
}

/** The subset of the query string a handler is allowed to depend on. */
export interface CoreQuery {
  get(name: string): string | null;
}

export interface CoreRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: CoreHeaders;
  readonly query: CoreQuery;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Assignable to `HttpResponseInit`. `jsonBody` and `body` are mutually
 * exclusive in practice; the hosts serialize whichever is present.
 */
export interface CoreResponse {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  body?: string;
}

/** Somewhere to report failures that must not reach the caller. */
export interface CoreLogger {
  error(message: string): void;
}

/**
 * The origin a client used to reach this request.
 *
 * Behind Static Web Apps the request URL carries the internal Functions
 * hostname, so anything a client is expected to call back on — the OAuth
 * metadata, the token audience — has to come from the headers the proxy adds
 * instead. `x-ms-original-url` is the Static Web Apps one; `x-forwarded-host`
 * covers every other reverse proxy. `apps/server` builds the URL from those
 * same headers already, so this agrees with it.
 */
export function requestOrigin(request: Pick<CoreRequest, "url" | "headers">): string {
  const original = first(request.headers.get("x-ms-original-url"));
  if (original !== null) {
    try {
      return new URL(original).origin;
    } catch {
      // Fall through to the remaining sources.
    }
  }
  const host = first(request.headers.get("x-forwarded-host"));
  if (host === null) {
    return new URL(request.url).origin;
  }
  const protocol = first(request.headers.get("x-forwarded-proto")) ?? "https";
  return `${protocol}://${host}`;
}

function first(header: string | null): string | null {
  const value = header?.split(",")[0]?.trim();
  return value === undefined || value === "" ? null : value;
}
