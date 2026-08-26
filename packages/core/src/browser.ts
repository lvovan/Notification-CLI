import type { CoreRequest, CoreResponse } from "./http.js";
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
  request: CoreRequest,
  createClient: () => NotificationNegotiator = createWebPubSubClient,
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request);
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
  request: CoreRequest,
): CoreResponse {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  return {
    status: 200,
    headers: { "Cache-Control": "no-store" },
    jsonBody: {
      authenticated: true,
      email: authorization.email,
    },
  };
}
