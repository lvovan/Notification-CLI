import type { CoreRequest, CoreResponse } from "./http.js";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import { ConfigurationError } from "./configuration.js";
import { userKey } from "./identity.js";
import {
  tryCreateNotificationMetricsStore,
  type NotificationMetricsStore,
} from "./metrics-storage.js";

export async function handleMetricsRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: NotificationMetricsStore | null,
  now: () => Date = () => new Date(),
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const metrics =
    store === undefined ? tryCreateNotificationMetricsStore(env) : store;
  if (!metrics) {
    return {
      status: 503,
      headers: { "Cache-Control": "no-store" },
      jsonBody: {
        error:
          "NOTIFICATION_CLI_STORAGE_CONNECTION_STRING is not configured.",
      },
    };
  }

  try {
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      // The partition comes from the signed-in principal, never from the
      // request, so a caller cannot ask for another account's counters.
      jsonBody: await metrics.counts(userKey(authorization.email), now()),
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return {
        status: 503,
        headers: { "Cache-Control": "no-store" },
        jsonBody: { error: error.message },
      };
    }
    throw error;
  }
}
