import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CoreLogger } from "@notification-cli/core/http";
import { API_ROUTES, OAUTH_ROUTES, type CoreRoute } from "@notification-cli/core/routes";
import { requestOrigin, toCoreRequest } from "./request.js";
import { send } from "./response.js";
import { serveStatic } from "./static.js";
import { clientPrincipal, type SessionProvider } from "./session.js";

function index(routes: readonly CoreRoute[], key: (route: CoreRoute) => string) {
  const byPath = new Map<string, CoreRoute[]>();
  for (const route of routes) {
    const path = key(route);
    const existing = byPath.get(path);
    if (existing) {
      existing.push(route);
    } else {
      byPath.set(path, [route]);
    }
  }
  return byPath;
}

const API = index(API_ROUTES, (route) => `/api/${route.path}`);
const OAUTH = index(OAUTH_ROUTES, (route) => route.path);

export interface ServerOptions {
  /** Directory holding the built PWA. */
  webRoot: string;
  session: SessionProvider;
  logger?: CoreLogger;
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Runs a handler with the resolved session presented as the client principal.
 * Returns false when no route claims the path, so the caller can decide what
 * a miss means.
 */
async function dispatch(
  routes: Map<string, CoreRoute[]>,
  message: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: ServerOptions,
): Promise<boolean> {
  const candidates = routes.get(pathname);
  if (!candidates) {
    return false;
  }
  const route = candidates.find((candidate) => candidate.method === message.method);
  if (!route) {
    send(response, {
      status: 405,
      headers: { ...NO_STORE, Allow: candidates.map((candidate) => candidate.method).join(", ") },
      jsonBody: { error: "Method not allowed." },
    });
    return true;
  }

  const email = await options.session.resolve(message);
  const injected = email ? { "x-ms-client-principal": clientPrincipal(email) } : {};
  const request = toCoreRequest(message, requestOrigin(message), injected);
  send(response, await route.handler(request, options.logger ?? console));
  return true;
}

/** Everything outside `/api` and `/.auth` is the application, and is gated. */
async function serveApplication(
  message: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ServerOptions,
): Promise<void> {
  const email = await options.session.resolve(message);
  if (!email) {
    const target = encodeURIComponent(`${url.pathname}${url.search}`);
    response.writeHead(302, {
      Location: `/.auth/login/aad?post_login_redirect_uri=${target}`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }
  await serveStatic(response, options.webRoot, url.pathname);
}

export function createRequestListener(
  options: ServerOptions,
): (message: IncomingMessage, response: ServerResponse) => void {
  const logger = options.logger ?? console;

  return (message, response) => {
    const url = new URL(message.url ?? "/", requestOrigin(message));
    void (async () => {
      try {
        if (url.pathname.startsWith("/.auth/")) {
          if (!(await options.session.handle(message, response, url.pathname))) {
            send(response, { status: 404, headers: NO_STORE, jsonBody: { error: "Not found." } });
          }
          return;
        }
        if (await dispatch(OAUTH, message, response, url.pathname, options)) {
          return;
        }
        // Reserved prefixes never fall through to the application shell, so a
        // client probing for an endpoint gets a clear miss rather than HTML.
        if (
          url.pathname.startsWith("/api/") ||
          url.pathname.startsWith("/oauth/") ||
          url.pathname.startsWith("/.well-known/")
        ) {
          if (!(await dispatch(API, message, response, url.pathname, options))) {
            send(response, {
              status: 404,
              headers: NO_STORE,
              jsonBody: { error: "Unknown endpoint." },
            });
          }
          return;
        }
        await serveApplication(message, response, url, options);
      } catch (error) {
        logger.error(`Unhandled request failure: ${String(error)}`);
        if (!response.headersSent) {
          send(response, {
            status: 500,
            headers: NO_STORE,
            jsonBody: { error: "The request could not be completed." },
          });
        } else {
          response.end();
        }
      }
    })();
  };
}

export function createNotificationServer(options: ServerOptions): Server {
  return createServer(createRequestListener(options));
}
