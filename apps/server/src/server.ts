import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CoreLogger } from "@notification-cli/core/http";
import { API_ROUTES, type CoreRoute } from "@notification-cli/core/routes";
import { requestOrigin, toCoreRequest } from "./request.js";
import { send } from "./response.js";
import { serveStatic } from "./static.js";
import { clientPrincipal, type SessionProvider } from "./session.js";

const BY_PATH = new Map<string, CoreRoute[]>();
for (const route of API_ROUTES) {
  const existing = BY_PATH.get(route.path);
  if (existing) {
    existing.push(route);
  } else {
    BY_PATH.set(route.path, [route]);
  }
}

export interface ServerOptions {
  /** Directory holding the built PWA. */
  webRoot: string;
  session: SessionProvider;
  logger?: CoreLogger;
}

const NO_STORE = { "Cache-Control": "no-store" };

async function dispatchApi(
  message: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: ServerOptions,
): Promise<void> {
  const candidates = BY_PATH.get(pathname.slice("/api/".length));
  if (!candidates) {
    send(response, { status: 404, headers: NO_STORE, jsonBody: { error: "Unknown endpoint." } });
    return;
  }
  const route = candidates.find((candidate) => candidate.method === message.method);
  if (!route) {
    send(response, {
      status: 405,
      headers: { ...NO_STORE, Allow: candidates.map((c) => c.method).join(", ") },
      jsonBody: { error: "Method not allowed." },
    });
    return;
  }

  const email = await options.session.resolve(message);
  const injected = email ? { "x-ms-client-principal": clientPrincipal(email) } : {};
  const request = toCoreRequest(message, requestOrigin(message), injected);
  send(response, await route.handler(request, options.logger ?? console));
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
        if (url.pathname.startsWith("/api/")) {
          await dispatchApi(message, response, url.pathname, options);
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
