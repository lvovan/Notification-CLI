import type { CoreLogger, CoreRequest, CoreResponse } from "./http.js";
import { handleApiKeyCycleRequest, handleApiKeyRequest } from "./apikey.js";
import { handleNegotiateRequest, handleSessionRequest } from "./browser.js";
import { handleMcpRequest } from "./mcp.js";
import { handleMetricsRequest } from "./metrics.js";
import { handleNotifyRequest } from "./notify.js";
import {
  handleClearNotificationsRequest,
  handleNotificationsRequest,
} from "./notifications.js";
import {
  handleDeletePushSubscription,
  handlePushConfigRequest,
  handleSavePushSubscription,
} from "./push.js";
import { handleWhoamiRequest } from "./whoami.js";

export type CoreMethod = "GET" | "POST" | "DELETE";

export type CoreHandler = (
  request: CoreRequest,
  logger: CoreLogger,
) => CoreResponse | Promise<CoreResponse>;

export interface CoreRoute {
  readonly method: CoreMethod;
  /** Path below the `/api` prefix, without a leading slash. */
  readonly path: string;
  readonly handler: CoreHandler;
}

/**
 * The single description of the API surface.
 *
 * Both hosts — the Azure Functions app and the App Service server — mount this
 * table, so the two are interchangeable by construction rather than by
 * convention.
 */
export const API_ROUTES: readonly CoreRoute[] = [
  { method: "GET", path: "negotiate", handler: (request) => handleNegotiateRequest(request) },
  { method: "GET", path: "session", handler: (request) => handleSessionRequest(request) },
  {
    method: "POST",
    path: "mcp",
    handler: (request, logger) => handleMcpRequest(request, undefined, undefined, logger),
  },
  { method: "GET", path: "push/config", handler: (request) => handlePushConfigRequest(request) },
  {
    method: "POST",
    path: "push/subscriptions",
    handler: (request) => handleSavePushSubscription(request),
  },
  {
    method: "DELETE",
    path: "push/subscriptions",
    handler: (request) => handleDeletePushSubscription(request),
  },
  { method: "GET", path: "metrics", handler: (request) => handleMetricsRequest(request) },
  {
    method: "GET",
    path: "notifications",
    handler: (request) => handleNotificationsRequest(request),
  },
  {
    method: "DELETE",
    path: "notifications",
    handler: (request) => handleClearNotificationsRequest(request),
  },
  {
    method: "POST",
    path: "notify",
    handler: (request, logger) => handleNotifyRequest(request, undefined, undefined, logger),
  },
  { method: "GET", path: "apikey", handler: (request) => handleApiKeyRequest(request) },
  { method: "POST", path: "apikey/cycle", handler: (request) => handleApiKeyCycleRequest(request) },
  { method: "GET", path: "whoami", handler: (request) => handleWhoamiRequest(request) },
];
