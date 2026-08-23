import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import { createWebPubSubClient } from "./web-pubsub.js";

interface WebPubSubNegotiator {
  getClientAccessToken(options: {
    expirationTimeInMinutes: number;
  }): Promise<{ url: string }>;
}

export async function handleNegotiateRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  createClient: () => WebPubSubNegotiator = createWebPubSubClient,
): Promise<HttpResponseInit> {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const token = await createClient().getClientAccessToken({
    expirationTimeInMinutes: 60,
  });
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
