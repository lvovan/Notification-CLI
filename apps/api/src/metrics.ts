import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  authorizeBrowserRequest,
  browserAuthorizationError,
} from "./auth.js";
import { ConfigurationError } from "./configuration.js";
import {
  tryCreateNotificationMetricsStore,
  type NotificationMetricsStore,
} from "./metrics-storage.js";

export async function handleMetricsRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: NotificationMetricsStore | null,
  now: () => Date = () => new Date(),
): Promise<HttpResponseInit> {
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
      jsonBody: await metrics.counts(now()),
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
