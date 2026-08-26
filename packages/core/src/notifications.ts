import type { CoreRequest, CoreResponse } from "./http.js";
import { authorizeBrowserRequest, browserAuthorizationError } from "./auth.js";
import { ConfigurationError } from "./configuration.js";
import { userKey } from "./identity.js";
import {
  DEFAULT_NOTIFICATION_PAGE_LIMIT,
  MAX_NOTIFICATION_PAGE_LIMIT,
  NotificationCursorError,
  parseRetentionDays,
  parseNotificationCursor,
  RETENTION_DAYS_ENV,
  tryCreateNotificationHistoryStore,
  type NotificationHistoryStore,
} from "./notification-storage.js";
import { STORAGE_CONNECTION_STRING_ENV } from "./table-storage.js";

const NO_STORE = { "Cache-Control": "no-store" };

function queryParameter(request: CoreRequest, name: string): string | null {
  return request.query.get(name);
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return DEFAULT_NOTIFICATION_PAGE_LIMIT;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new RangeError(
      `limit must be a positive integer between 1 and ${MAX_NOTIFICATION_PAGE_LIMIT}.`,
    );
  }
  const limit = Number(value);
  if (limit < 1 || limit > MAX_NOTIFICATION_PAGE_LIMIT) {
    throw new RangeError(
      `limit must be a positive integer between 1 and ${MAX_NOTIFICATION_PAGE_LIMIT}.`,
    );
  }
  return limit;
}

function storageUnavailable(): CoreResponse {
  return {
    status: 503,
    headers: NO_STORE,
    jsonBody: {
      error: `${STORAGE_CONNECTION_STRING_ENV} is not configured.`,
    },
  };
}

export async function handleNotificationsRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: NotificationHistoryStore | null,
  now: () => Date = () => new Date(),
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  let limit: number;
  let cursor: string | undefined;
  try {
    limit = parseLimit(queryParameter(request, "limit"));
    const before = queryParameter(request, "before");
    if (before !== null) {
      parseNotificationCursor(before);
      cursor = before;
    }
  } catch (error) {
    if (error instanceof RangeError || error instanceof NotificationCursorError) {
      return {
        status: 400,
        headers: NO_STORE,
        jsonBody: { error: error.message },
      };
    }
    throw error;
  }

  const history =
    store === undefined ? tryCreateNotificationHistoryStore(env) : store;
  if (!history) {
    return storageUnavailable();
  }

  try {
    const retentionDays = parseRetentionDays(env[RETENTION_DAYS_ENV]);
    return {
      status: 200,
      headers: NO_STORE,
      jsonBody: {
        retentionDays,
        // The partition comes from the signed-in principal, never from the
        // request, so a caller cannot page through another account's history.
        ...(await history.list(
          userKey(authorization.email),
          now(),
          retentionDays,
          {
            limit,
            ...(cursor !== undefined ? { cursor } : {}),
          },
        )),
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

/**
 * Empties the caller's notification history. The partition comes from the
 * signed-in principal, so a caller can only ever clear their own. Metrics live
 * in their own table and are deliberately untouched: the counters describe
 * everything ever sent, not what is currently listed.
 */
export async function handleClearNotificationsRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store?: NotificationHistoryStore | null,
): Promise<CoreResponse> {
  const authorization = authorizeBrowserRequest(request);
  if (!authorization.authorized) {
    return browserAuthorizationError(authorization);
  }

  const history =
    store === undefined ? tryCreateNotificationHistoryStore(env) : store;
  if (!history) {
    return storageUnavailable();
  }

  try {
    return {
      status: 200,
      headers: NO_STORE,
      jsonBody: { deleted: await history.clear(userKey(authorization.email)) },
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
