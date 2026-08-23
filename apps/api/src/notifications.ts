import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { authorizeBrowserRequest, browserAuthorizationError } from "./auth.js";
import { ConfigurationError } from "./configuration.js";
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

function queryParameter(request: HttpRequest, name: string): string | null {
  const { query, url } = request as HttpRequest & { query?: URLSearchParams };
  const fromQuery = query?.get(name) ?? null;
  if (fromQuery !== null) {
    return fromQuery;
  }
  return url ? new URL(url).searchParams.get(name) : null;
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
        ...(await history.list(now(), retentionDays, {
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        })),
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
