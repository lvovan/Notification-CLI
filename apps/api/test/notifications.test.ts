import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { ConfigurationError } from "../src/configuration.js";
import { fanOutNotification } from "../src/fanout.js";
import { notificationOwner, userGroup, userKey } from "../src/identity.js";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_PAGE_LIMIT,
  parseRetentionDays,
  type NotificationHistoryStore,
  type NotificationListOptions,
  type NotificationPage,
  type StoredNotification,
  notificationCursor,
} from "../src/notification-storage.js";
import { handleNotificationsRequest } from "../src/notifications.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";

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
    mine.jsonBody.notifications.map((entry: StoredNotification) => entry.id),
    ["mine"],
  );
  assert.deepEqual(
    theirs.jsonBody.notifications.map((entry: StoredNotification) => entry.id),
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
    assert.deepEqual(response.jsonBody.notifications, [], url);
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
  assert.equal(
    response.jsonBody.notifications.length,
    DEFAULT_NOTIFICATION_PAGE_LIMIT,
  );
  assert.equal(
    response.jsonBody.nextCursor,
    notificationCursor(response.jsonBody.notifications[4]),
  );
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
    pages.push(response.jsonBody.notifications);
    cursor = response.jsonBody.nextCursor;
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
    assert.match(response.jsonBody.error, /limit|before/);
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
      ...response.jsonBody.notifications.map(
        (entry: StoredNotification) => entry.id,
      ),
    );
    cursor = response.jsonBody.nextCursor;
  }

  assert.deepEqual(seen, ["c", "b", "a"]);
  assert.equal(cursor, null);
});
