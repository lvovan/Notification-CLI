import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import {
  createWebPubSubClient,
  issueClientAccessToken,
  type NotificationNegotiator,
} from "./web-pubsub.js";

export async function handleNegotiateRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  createClient: () => NotificationNegotiator = createWebPubSubClient,
): Promise<HttpResponseInit> {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const token = await issueClientAccessToken(
    createClient(),
    authorization.email,
  );
  return {
    status: 200,
    jsonBody: { url: token.url },
    headers: { "Cache-Control": "no-store" },
  };
}

export function handleSessionRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
): HttpResponseInit {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  return {
    status: 200,
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      authenticated: true,
      authorized: true,
      email: authorization.email,
    },
  };
}
