import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { authorizeBrowserRequest, browserAuthorizationError } from "./auth.js";
import { ConfigurationError } from "./configuration.js";
import {
  parseRetentionDays,
  RETENTION_DAYS_ENV,
  tryCreateNotificationHistoryStore,
  type NotificationHistoryStore,
} from "./notification-storage.js";
import { STORAGE_CONNECTION_STRING_ENV } from "./table-storage.js";

const NO_STORE = { "Cache-Control": "no-store" };

export async function handleNotificationsRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: NotificationHistoryStore | null,
  now: () => Date = () => new Date(),
): Promise<HttpResponseInit> {
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const history =
    store === undefined ? tryCreateNotificationHistoryStore(env) : store;
  if (!history) {
    return {
      status: 503,
      headers: NO_STORE,
      jsonBody: {
        error: `${STORAGE_CONNECTION_STRING_ENV} is not configured.`,
      },
    };
  }

  try {
    const retentionDays = parseRetentionDays(env[RETENTION_DAYS_ENV]);
    return {
      status: 200,
      headers: NO_STORE,
      jsonBody: {
        retentionDays,
        notifications: await history.list(now(), retentionDays),
      },
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return {
        status: 503,
        headers: NO_STORE,
        jsonBody: { error: error.message },
      };
    }
    throw error;
  }
}
