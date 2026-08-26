import type { CoreRequest, CoreResponse } from "./http.js";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import { ConfigurationError } from "./configuration.js";
import {
  VAPID_PUBLIC_KEY_ENV,
} from "./fanout.js";
import {
  createPushSubscriptionStore,
  parsePushSubscription,
  type PushSubscriptionStore,
} from "./push-storage.js";

function noStore(response: CoreResponse): CoreResponse {
  return {
    ...response,
    headers: { ...response.headers, "Cache-Control": "no-store" },
  };
}

function configurationUnavailable(error: unknown): CoreResponse {
  if (error instanceof ConfigurationError) {
    return noStore({ status: 503, jsonBody: { error: error.message } });
  }
  throw error;
}

export function handlePushConfigRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
): CoreResponse {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }
  const publicKey = env[VAPID_PUBLIC_KEY_ENV]?.trim();
  if (!publicKey || !/^B[A-Za-z0-9_-]{86}$/.test(publicKey)) {
    return noStore({
      status: 503,
      jsonBody: {
        error: `${VAPID_PUBLIC_KEY_ENV} is not configured with a valid VAPID public key.`,
      },
    });
  }
  return noStore({ status: 200, jsonBody: { publicKey } });
}

export async function handleSavePushSubscription(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: PushSubscriptionStore,
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body." } };
  }
  const subscription = parsePushSubscription(value);
  if (!subscription) {
    return {
      status: 400,
      jsonBody: { error: "A valid PushSubscription is required." },
    };
  }

  try {
    await (store ?? createPushSubscriptionStore(env)).save(
      authorization.email,
      subscription,
    );
  } catch (error) {
    return configurationUnavailable(error);
  }
  return { status: 204 };
}

export async function handleDeletePushSubscription(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: PushSubscriptionStore,
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Invalid JSON body." } };
  }
  const endpoint =
    typeof value === "object" &&
    value !== null &&
    "endpoint" in value &&
    typeof value.endpoint === "string"
      ? value.endpoint
      : null;
  if (!endpoint || endpoint.length > 4096) {
    return {
      status: 400,
      jsonBody: { error: "A subscription endpoint is required." },
    };
  }

  try {
    await (store ?? createPushSubscriptionStore(env)).remove(
      authorization.email,
      endpoint,
    );
  } catch (error) {
    return configurationUnavailable(error);
  }
  return { status: 204 };
}
