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
