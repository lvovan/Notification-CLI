import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import type { CoreResponse } from "@notification-cli/core/http";
import { ConfigurationError } from "@notification-cli/core/configuration";
import { fanOutNotification } from "@notification-cli/core/fanout";
import { notificationOwner, userGroup, userKey } from "@notification-cli/core/identity";
import { handleMetricsRequest } from "@notification-cli/core/metrics";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_PAGE_LIMIT,
  parseRetentionDays,
  type NotificationHistoryStore,
  type NotificationListOptions,
  type NotificationPage,
  type StoredNotification,
  notificationCursor,
} from "@notification-cli/core/notification-storage";
import {
  handleClearNotificationsRequest,
  handleNotificationsRequest,
} from "@notification-cli/core/notifications";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";

interface NotificationsBody {
  retentionDays: number;
  notifications: StoredNotification[];
  nextCursor: string | null;
  error: string;
}

/** The responses are typed as unknown, so the assertions name their shape. */
function body(response: CoreResponse): NotificationsBody {
  return response.jsonBody as NotificationsBody;
}

function principalHeader(email = OWNER): string {
  return Buffer.from(
    JSON.stringify({
      identityProvider: "aad",
      userId: "user-id",
      userDetails: email,
      userRoles: ["authenticated"],
    }),
  ).toString("base64");
}

function request(
  headers: Record<string, string>,
  url = "https://example.com/api/notifications",
): HttpRequest {
  return {
    headers: new Headers(headers),
    url,
    query: new URL(url).searchParams,
  } as unknown as HttpRequest;
}

function signedIn(
  email = OWNER,
  url = "https://example.com/api/notifications",
): HttpRequest {
  return request({ "x-ms-client-principal": principalHeader(email) }, url);
}

function notification(
  id: string,
  sentAt: number,
  body = id,
): StoredNotification {
  return { id, title: "Notification CLI", body, sentAt };
}

/**
 * Partitions by user exactly as the table store does, so an endpoint that
 * forgot to scope its query surfaces here rather than in production. Paging
 * treats the cursor as opaque, keeping these endpoint tests independent of
 * how the store encodes it.
 */
class MemoryHistoryStore implements NotificationHistoryStore {
  readonly partitions = new Map<string, StoredNotification[]>();
  readonly pruned: Array<{ userKey: string; now: Date; retentionDays: number }> =
    [];

  async append(
    partition: string,
    entry: StoredNotification,
  ): Promise<void> {
    const existing = this.partitions.get(partition) ?? [];
    existing.push(entry);
    this.partitions.set(partition, existing);
  }

  entries(partition: string): StoredNotification[] {
    return [...(this.partitions.get(partition) ?? [])].sort((left, right) =>
      right.sentAt === left.sentAt
        ? right.id.localeCompare(left.id)
        : right.sentAt - left.sentAt,
    );
  }

  async list(
    partition: string,
    _now: Date,
    _retentionDays: number,
    options: NotificationListOptions = {},
  ): Promise<NotificationPage> {
    const ordered = this.entries(partition);
    const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_LIMIT;
    const start =
      options.cursor === undefined
        ? 0
        : ordered.findIndex(
            (entry) => notificationCursor(entry) === options.cursor,
          ) + 1;
    const page = ordered.slice(start, start + limit + 1);
    const notifications = page.slice(0, limit);
    return {
      notifications,
      nextCursor:
        page.length > limit && notifications.length > 0
          ? notificationCursor(notifications[notifications.length - 1]!)
          : null,
    };
  }

  async prune(
    partition: string,
    now: Date,
    retentionDays: number,
  ): Promise<number> {
    this.pruned.push({ userKey: partition, now, retentionDays });
    return 3;
  }

  async clear(partition: string): Promise<number> {
    const removed = this.partitions.get(partition)?.length ?? 0;
    this.partitions.delete(partition);
    return removed;
  }
}

const noMetrics = {
  record: async () => undefined,
  counts: async () => ({
    last24Hours: 0,
    last7Days: 0,
    last30Days: 0,
    total: 0,
  }),
};

test("retention defaults to a week and rejects nonsense values", () => {
  assert.equal(parseRetentionDays(undefined), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays("  "), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays("30"), 30);
  for (const invalid of ["0", "-1", "1.5", "abc", "400"]) {
    assert.throws(
      () => parseRetentionDays(invalid),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.setting === "NOTIFICATION_CLI_RETENTION_DAYS",
      `expected ${invalid} to be rejected`,
    );
  }
});

test("sending retains and sweeps only the sender's own partition", async () => {
  const history = new MemoryHistoryStore();
  const groups: string[] = [];
  const report = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    notificationId: () => "notification-id",
    now: () => NOW,
    webPubSub: {
      group: (name) => {
        groups.push(name);
        return { sendToAll: async () => undefined };
      },
    },
    store: null as never,
    webPush: null as never,
    metrics: noMetrics,
    history,
  });

  assert.deepEqual(groups, [userGroup(OWNER)]);
  assert.deepEqual(history.entries(userKey(OWNER)), [
    notification("notification-id", NOW.getTime(), "hello"),
  ]);
  assert.deepEqual(history.pruned, [
    { userKey: userKey(OWNER), now: NOW, retentionDays: DEFAULT_RETENTION_DAYS },
  ]);
  assert.equal(history.partitions.has(userKey(OTHER)), false);
  assert.equal(report.historyRecorded, true);
  assert.equal(report.historyPruned, 3);
});

test("a retention failure never fails a delivered notification", async () => {
  const report = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    now: () => NOW,
    webPubSub: { group: () => ({ sendToAll: async () => undefined }) },
    store: null as never,
    webPush: null as never,
    metrics: noMetrics,
    history: {
      append: async () => {
        throw new Error("table storage unavailable");
      },
      list: async () => ({ notifications: [], nextCursor: null }),
      prune: async () => 0,
      clear: async () => 0,
    },
  });

  assert.equal(report.webPubSubDelivered, true);
  assert.equal(report.historyRecorded, undefined);
  assert.equal(report.historyError, "table storage unavailable");
  assert.deepEqual(report.errors, []);
});

test("the notifications endpoint is gated and reports the retention window", async () => {
  const store = new MemoryHistoryStore();
  await store.append(userKey(OWNER), notification("one", NOW.getTime(), "hello"));
  const env = {
    AUTHORIZED_USERS: `${OWNER};${OTHER}`,
    NOTIFICATION_CLI_RETENTION_DAYS: "14",
  };

  const anonymous = await handleNotificationsRequest(
    request({}),
    env,
    store,
    () => NOW,
  );
  assert.equal(anonymous.status, 401);

  const authorized = await handleNotificationsRequest(
    signedIn(),
    env,
    store,
    () => NOW,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.jsonBody, {
    retentionDays: 14,
    notifications: store.entries(userKey(OWNER)),
    nextCursor: null,
  });
  assert.equal(
    (authorized.headers as Record<string, string>)["Cache-Control"],
    "no-store",
  );

  const unconfigured = await handleNotificationsRequest(
    signedIn(),
    { AUTHORIZED_USERS: OWNER },
    null,
    () => NOW,
  );
  assert.equal(unconfigured.status, 503);

  const misconfigured = await handleNotificationsRequest(
    signedIn(),
    { ...env, NOTIFICATION_CLI_RETENTION_DAYS: "soon" },
    store,
    () => NOW,
  );
  assert.equal(misconfigured.status, 503);
});

test("the notifications endpoint never returns another account's history", async () => {
  const store = new MemoryHistoryStore();
  await store.append(userKey(OWNER), notification("mine", NOW.getTime()));
  await store.append(userKey(OTHER), notification("theirs", NOW.getTime()));
  const env = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };

  const mine = await handleNotificationsRequest(signedIn(), env, store, () => NOW);
  const theirs = await handleNotificationsRequest(
    signedIn(OTHER),
    env,
    store,
    () => NOW,
  );

  assert.deepEqual(
    body(mine).notifications.map((entry: StoredNotification) => entry.id),
    ["mine"],
  );
  assert.deepEqual(
    body(theirs).notifications.map((entry: StoredNotification) => entry.id),
    ["theirs"],
  );
});

test("the endpoint ignores any account identifier supplied by the caller", async () => {
  const store = new MemoryHistoryStore();
  await store.append(userKey(OTHER), notification("theirs", NOW.getTime()));
  const env = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };

  for (const url of [
    `https://example.com/api/notifications?email=${encodeURIComponent(OTHER)}`,
    `https://example.com/api/notifications?user=${userKey(OTHER)}`,
    `https://example.com/api/notifications?userKey=${userKey(OTHER)}`,
  ]) {
    const response = await handleNotificationsRequest(
      signedIn(OWNER, url),
      env,
      store,
      () => NOW,
    );
    assert.equal(response.status, 200, url);
    assert.deepEqual(body(response).notifications, [], url);
  }
});

test("the notifications endpoint defaults to a five item page", async () => {
  const store = new MemoryHistoryStore();
  for (let index = 0; index < 6; index += 1) {
    await store.append(
      userKey(OWNER),
      notification(`notification-${index}`, NOW.getTime() - index),
    );
  }

  const response = await handleNotificationsRequest(
    signedIn(),
    { AUTHORIZED_USERS: OWNER },
    store,
    () => NOW,
  );

  assert.equal(response.status, 200);
  const page = body(response).notifications;
  assert.equal(page.length, DEFAULT_NOTIFICATION_PAGE_LIMIT);
  const last = page.at(-1);
  assert.ok(last);
  assert.equal(body(response).nextCursor, notificationCursor(last));
});

test("a notification cursor returns strictly older pages without gaps", async () => {
  const store = new MemoryHistoryStore();
  const expected: StoredNotification[] = [];
  for (let index = 0; index < 12; index += 1) {
    const entry = notification(
      `notification-${index.toString().padStart(2, "0")}`,
      NOW.getTime() - index,
    );
    expected.push(entry);
    await store.append(userKey(OWNER), entry);
  }

  const env = { AUTHORIZED_USERS: OWNER };
  const pages: StoredNotification[][] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const url = `https://example.com/api/notifications?limit=5${
      cursor ? `&before=${cursor}` : ""
    }`;
    const response = await handleNotificationsRequest(
      signedIn(OWNER, url),
      env,
      store,
      () => NOW,
    );
    assert.equal(response.status, 200);
    pages.push(body(response).notifications);
    cursor = body(response).nextCursor;
  }

  assert.deepEqual(pages.flat(), expected);
  assert.equal(cursor, null);
});

test("limit and before query validation returns bad request errors", async () => {
  const store = new MemoryHistoryStore();
  for (const url of [
    "https://example.com/api/notifications?limit=0",
    "https://example.com/api/notifications?limit=51",
    "https://example.com/api/notifications?limit=1.5",
    "https://example.com/api/notifications?limit=abc",
    "https://example.com/api/notifications?before=not-a-cursor",
  ]) {
    const response = await handleNotificationsRequest(
      signedIn(OWNER, url),
      { AUTHORIZED_USERS: OWNER },
      store,
      () => NOW,
    );
    assert.equal(response.status, 400, url);
    assert.match(body(response).error, /limit|before/);
  }
});

test("same-millisecond notifications page across the id tiebreak", async () => {
  const store = new MemoryHistoryStore();
  const sentAt = NOW.getTime();
  for (const id of ["a", "b", "c"]) {
    await store.append(userKey(OWNER), notification(id, sentAt));
  }

  const env = { AUTHORIZED_USERS: OWNER };
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 3; page += 1) {
    const url = `https://example.com/api/notifications?limit=1${
      cursor ? `&before=${cursor}` : ""
    }`;
    const response = await handleNotificationsRequest(
      signedIn(OWNER, url),
      env,
      store,
      () => NOW,
    );
    seen.push(
      ...body(response).notifications.map(
        (entry: StoredNotification) => entry.id,
      ),
    );
    cursor = body(response).nextCursor;
  }

  assert.deepEqual(seen, ["c", "b", "a"]);
  assert.equal(cursor, null);
});

test("clearing removes only the caller's notifications", async () => {
  const store = new MemoryHistoryStore();
  await store.append(userKey(OWNER), notification("mine", NOW.getTime()));
  await store.append(userKey(OTHER), notification("theirs", NOW.getTime()));
  const env = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };

  const response = await handleClearNotificationsRequest(
    signedIn(OWNER),
    env,
    store,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody, { deleted: 1 });
  assert.deepEqual(store.entries(userKey(OWNER)), []);
  assert.deepEqual(
    store.entries(userKey(OTHER)).map((entry) => entry.id),
    ["theirs"],
    "another account's history must survive",
  );
});

test("clearing leaves the metrics untouched", async () => {
  const history = new MemoryHistoryStore();
  await history.append(userKey(OWNER), notification("mine", NOW.getTime()));
  const counts = { last24Hours: 4, last7Days: 9, last30Days: 12, total: 40 };
  const metrics = {
    record: async () => undefined,
    counts: async () => counts,
  };
  const env = { AUTHORIZED_USERS: OWNER };

  await handleClearNotificationsRequest(signedIn(OWNER), env, history);

  // Counters live in their own store, and the clear endpoint is not even given
  // one, so a request served afterwards still reports every send ever made.
  const after = await handleMetricsRequest(signedIn(OWNER), env, metrics);
  assert.equal(after.status, 200);
  assert.deepEqual(after.jsonBody, counts);
});

test("clearing refuses an unauthenticated or unauthorized caller", async () => {
  const store = new MemoryHistoryStore();
  await store.append(userKey(OWNER), notification("mine", NOW.getTime()));

  const anonymous = await handleClearNotificationsRequest(request({}), {}, store);
  assert.equal(anonymous.status, 401);

  const stranger = await handleClearNotificationsRequest(
    signedIn(OTHER),
    { AUTHORIZED_USERS: OWNER },
    store,
  );
  assert.equal(stranger.status, 403);

  assert.equal(store.entries(userKey(OWNER)).length, 1);
});

test("clearing reports storage that is not configured", async () => {
  const response = await handleClearNotificationsRequest(
    signedIn(OWNER),
    { AUTHORIZED_USERS: OWNER },
    null,
  );

  assert.equal(response.status, 503);
  assert.match(body(response).error, /NOTIFICATION_CLI_STORAGE/);
});
