import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { ConfigurationError } from "../src/configuration.js";
import { fanOutNotification } from "../src/fanout.js";
import {
  AzureTableNotificationHistoryStore,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_NOTIFICATION_PAGE_LIMIT,
  parseRetentionDays,
  parseNotificationCursor,
  retentionCutoffDay,
  type NotificationHistoryStore,
  type NotificationListOptions,
  type NotificationPage,
  type StoredNotification,
  notificationCursor,
} from "../src/notification-storage.js";
import { handleNotificationsRequest } from "../src/notifications.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");

function principalHeader(email = "user@example.com"): string {
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

function compareNewestFirst(
  left: StoredNotification,
  right: StoredNotification,
): number {
  const sentAtOrder = right.sentAt - left.sentAt;
  if (sentAtOrder !== 0) {
    return sentAtOrder;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id > right.id ? -1 : 1;
}

class MemoryHistoryStore implements NotificationHistoryStore {
  readonly appended: StoredNotification[] = [];
  readonly pruned: Array<{ now: Date; retentionDays: number }> = [];

  async append(notification: StoredNotification): Promise<void> {
    this.appended.push(notification);
  }

  async list(
    _now: Date,
    _retentionDays: number,
    options: NotificationListOptions = {},
  ): Promise<NotificationPage> {
    const cursor =
      options.cursor === undefined ? undefined : parseNotificationCursor(options.cursor);
    const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_LIMIT;
    const page = [...this.appended]
      .sort(compareNewestFirst)
      .filter(
        (notification) =>
          !cursor ||
          notification.sentAt < cursor.sentAt ||
          (notification.sentAt === cursor.sentAt && notification.id < cursor.id),
      )
      .slice(0, limit + 1);
    const notifications = page.slice(0, limit);
    return {
      notifications,
      nextCursor:
        page.length > limit && notifications.length > 0
          ? notificationCursor(notifications[notifications.length - 1]!)
          : null,
    };
  }

  async prune(now: Date, retentionDays: number): Promise<number> {
    this.pruned.push({ now, retentionDays });
    return 3;
  }
}

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

test("listing and pruning agree on the retention cutoff day", () => {
  assert.equal(retentionCutoffDay(NOW, 7), "2026-03-08");
  assert.equal(retentionCutoffDay(NOW, 1), "2026-03-14");
});

test("pruning deletes only partitions older than the cutoff", async () => {
  const rows = [
    { partitionKey: "2026-03-01", rowKey: "a" },
    { partitionKey: "2026-03-07", rowKey: "b" },
  ];
  const filters: string[] = [];
  const deleted: string[] = [];
  const client = {
    createTable: async () => undefined,
    listEntities: (options: { queryOptions: { filter: string } }) => {
      filters.push(options.queryOptions.filter);
      return {
        async *[Symbol.asyncIterator]() {
          yield* rows;
        },
      };
    },
    deleteEntity: async (partitionKey: string, rowKey: string) => {
      deleted.push(`${partitionKey}/${rowKey}`);
      if (rowKey === "b") {
        // A concurrent sweep may have removed the row already.
        throw Object.assign(new Error("gone"), { statusCode: 404 });
      }
    },
  };
  const store = new AzureTableNotificationHistoryStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationHistoryStore
    >[0],
  );

  assert.equal(await store.prune(NOW, 7), 1);
  assert.deepEqual(deleted, ["2026-03-01/a", "2026-03-07/b"]);
  assert.match(filters[0] ?? "", /PartitionKey lt '2026-03-08'/);
});

test("listing pages retained notifications newest first by day partition", async () => {
  const filters: string[] = [];
  const rows = new Map<string, Array<Partial<StoredNotification>>>([
    [
      "2026-03-15",
      [
        { id: "d15-a", body: "15a", sentAt: Date.parse("2026-03-15T01:00:00Z") },
        { id: "d15-b", body: "15b", sentAt: Date.parse("2026-03-15T02:00:00Z") },
      ],
    ],
    [
      "2026-03-14",
      [
        { id: "d14-a", body: "14a", sentAt: Date.parse("2026-03-14T01:00:00Z") },
        { id: "d14-b", body: "14b", sentAt: Date.parse("2026-03-14T02:00:00Z") },
      ],
    ],
    [
      "2026-03-13",
      [
        { id: "d13-a", body: "13a", sentAt: Date.parse("2026-03-13T01:00:00Z") },
        { id: "d13-b", body: "13b", sentAt: Date.parse("2026-03-13T02:00:00Z") },
        { id: "broken", body: "dropped" },
      ],
    ],
  ]);
  const client = {
    createTable: async () => undefined,
    listEntities: (options: { queryOptions: { filter: string } }) => {
      filters.push(options.queryOptions.filter);
      const partition = /PartitionKey eq '([^']+)'/.exec(
        options.queryOptions.filter,
      )?.[1];
      return {
        async *[Symbol.asyncIterator]() {
          yield* partition ? (rows.get(partition) ?? []) : [];
        },
      };
    },
  };
  const store = new AzureTableNotificationHistoryStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationHistoryStore
    >[0],
  );

  const page = await store.list(NOW, 7, { limit: 5 });
  assert.deepEqual(
    page.notifications.map((notification) => notification.id),
    ["d15-b", "d15-a", "d14-b", "d14-a", "d13-b"],
  );
  assert.equal(
    page.nextCursor,
    `${Date.parse("2026-03-13T02:00:00Z")}:d13-b`,
  );
  assert.deepEqual(filters, [
    "PartitionKey eq '2026-03-15'",
    "PartitionKey eq '2026-03-14'",
    "PartitionKey eq '2026-03-13'",
  ]);

  filters.length = 0;
  const nextPage = await store.list(NOW, 7, {
    limit: 1,
    cursor: page.nextCursor!,
  });
  assert.deepEqual(
    nextPage.notifications.map((notification) => notification.id),
    ["d13-a"],
  );
  assert.equal(filters[0], "PartitionKey eq '2026-03-13'");
});

test("sending retains the notification and sweeps expired ones", async () => {
  const history = new MemoryHistoryStore();
  const report = await fanOutNotification("hello", {
    env: { AUTHORIZED_USERS: "user@example.com" },
    notificationId: () => "notification-id",
    now: () => NOW,
    webPubSub: { sendToAll: async () => undefined },
    store: null as never,
    webPush: null as never,
    metrics: { record: async () => undefined, counts: async () => ({
      last24Hours: 0,
      last7Days: 0,
      last30Days: 0,
      total: 0,
    }) },
    history,
  });

  assert.deepEqual(history.appended, [
    {
      id: "notification-id",
      title: "Notification CLI",
      body: "hello",
      sentAt: NOW.getTime(),
    },
  ]);
  assert.deepEqual(history.pruned, [
    { now: NOW, retentionDays: DEFAULT_RETENTION_DAYS },
  ]);
  assert.equal(report.historyRecorded, true);
  assert.equal(report.historyPruned, 3);
});

test("a retention failure never fails a delivered notification", async () => {
  const report = await fanOutNotification("hello", {
    env: { AUTHORIZED_USERS: "user@example.com" },
    now: () => NOW,
    webPubSub: { sendToAll: async () => undefined },
    store: null as never,
    webPush: null as never,
    metrics: { record: async () => undefined, counts: async () => ({
      last24Hours: 0,
      last7Days: 0,
      last30Days: 0,
      total: 0,
    }) },
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
  await store.append({
    id: "one",
    title: "Notification CLI",
    body: "hello",
    sentAt: NOW.getTime(),
  });
  const env = {
    AUTHORIZED_USERS: "user@example.com",
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
    request({ "x-ms-client-principal": principalHeader() }),
    env,
    store,
    () => NOW,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.jsonBody, {
    retentionDays: 14,
    notifications: store.appended,
    nextCursor: null,
  });
  assert.equal(
    (authorized.headers as Record<string, string>)["Cache-Control"],
    "no-store",
  );

  const unconfigured = await handleNotificationsRequest(
    request({ "x-ms-client-principal": principalHeader() }),
    { AUTHORIZED_USERS: "user@example.com" },
    null,
    () => NOW,
  );
  assert.equal(unconfigured.status, 503);

  const misconfigured = await handleNotificationsRequest(
    request({ "x-ms-client-principal": principalHeader() }),
    { ...env, NOTIFICATION_CLI_RETENTION_DAYS: "soon" },
    store,
    () => NOW,
  );
  assert.equal(misconfigured.status, 503);
});

test("the notifications endpoint defaults to a five item page", async () => {
  const store = new MemoryHistoryStore();
  for (let index = 0; index < 6; index += 1) {
    await store.append({
      id: `notification-${index}`,
      title: "Notification CLI",
      body: `body ${index}`,
      sentAt: NOW.getTime() - index,
    });
  }

  const response = await handleNotificationsRequest(
    request({ "x-ms-client-principal": principalHeader() }),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.notifications.length, DEFAULT_NOTIFICATION_PAGE_LIMIT);
  assert.equal(
    response.jsonBody.nextCursor,
    notificationCursor(response.jsonBody.notifications[4]),
  );
});

test("a notification cursor returns strictly older pages without gaps", async () => {
  const store = new MemoryHistoryStore();
  const expected: StoredNotification[] = [];
  for (let index = 0; index < 12; index += 1) {
    const notification = {
      id: `notification-${index.toString().padStart(2, "0")}`,
      title: "Notification CLI",
      body: `body ${index}`,
      sentAt: NOW.getTime() - index,
    };
    expected.push(notification);
    await store.append(notification);
  }

  const first = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      "https://example.com/api/notifications?limit=5",
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );
  const second = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      `https://example.com/api/notifications?limit=5&before=${first.jsonBody.nextCursor}`,
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );
  const third = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      `https://example.com/api/notifications?limit=5&before=${second.jsonBody.nextCursor}`,
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.deepEqual(
    [
      ...first.jsonBody.notifications,
      ...second.jsonBody.notifications,
      ...third.jsonBody.notifications,
    ],
    expected,
  );
  assert.equal(third.jsonBody.nextCursor, null);
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
      request({ "x-ms-client-principal": principalHeader() }, url),
      { AUTHORIZED_USERS: "user@example.com" },
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
    await store.append({
      id,
      title: "Notification CLI",
      body: id,
      sentAt,
    });
  }

  const first = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      "https://example.com/api/notifications?limit=1",
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );
  const second = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      `https://example.com/api/notifications?limit=1&before=${first.jsonBody.nextCursor}`,
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );
  const third = await handleNotificationsRequest(
    request(
      { "x-ms-client-principal": principalHeader() },
      `https://example.com/api/notifications?limit=1&before=${second.jsonBody.nextCursor}`,
    ),
    { AUTHORIZED_USERS: "user@example.com" },
    store,
    () => NOW,
  );

  assert.deepEqual(
    [
      first.jsonBody.notifications[0].id,
      second.jsonBody.notifications[0].id,
      third.jsonBody.notifications[0].id,
    ],
    ["c", "b", "a"],
  );
  assert.equal(third.jsonBody.nextCursor, null);
});
