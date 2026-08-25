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
import {
  authorizationServerMetadata,
  handleAuthorizeDecision,
  handleAuthorizeRequest,
  handleJwksRequest,
  handleRegisterRequest,
  handleTokenRequest,
  protectedResourceMetadata,
} from "./oauth-server.js";

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

/**
 * The authorization server and its discovery documents, at absolute paths.
 *
 * These are mounted only by the App Service host: Static Web Apps replaces the
 * `Authorization` header before a managed function sees it, so OAuth can never
 * work there and advertising it would strand compliant clients.
 */
export const OAUTH_ROUTES: readonly CoreRoute[] = [
  {
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    handler: (request) => protectedResourceMetadata(new URL(request.url).origin),
  },
  {
    method: "GET",
    path: "/.well-known/oauth-protected-resource/api/mcp",
    handler: (request) => protectedResourceMetadata(new URL(request.url).origin),
  },
  {
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    handler: (request) => authorizationServerMetadata(new URL(request.url).origin),
  },
  {
    method: "GET",
    path: "/.well-known/openid-configuration",
    handler: (request) => authorizationServerMetadata(new URL(request.url).origin),
  },
  { method: "GET", path: "/oauth/jwks", handler: (request) => handleJwksRequest(request) },
  { method: "POST", path: "/oauth/register", handler: (request) => handleRegisterRequest(request) },
  {
    method: "GET",
    path: "/oauth/authorize",
    handler: (request) => handleAuthorizeRequest(request),
  },
  {
    method: "POST",
    path: "/oauth/authorize",
    handler: (request) => handleAuthorizeDecision(request),
  },
  { method: "POST", path: "/oauth/token", handler: (request) => handleTokenRequest(request) },
];
