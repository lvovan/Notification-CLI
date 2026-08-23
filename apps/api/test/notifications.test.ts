import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { ConfigurationError } from "../src/configuration.js";
import { fanOutNotification } from "../src/fanout.js";
import {
  AzureTableNotificationHistoryStore,
  DEFAULT_RETENTION_DAYS,
  parseRetentionDays,
  retentionCutoffDay,
  type NotificationHistoryStore,
  type StoredNotification,
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

function request(headers: Record<string, string>): HttpRequest {
  return { headers: new Headers(headers) } as HttpRequest;
}

class MemoryHistoryStore implements NotificationHistoryStore {
  readonly appended: StoredNotification[] = [];
  readonly pruned: Array<{ now: Date; retentionDays: number }> = [];

  async append(notification: StoredNotification): Promise<void> {
    this.appended.push(notification);
  }

  async list(): Promise<StoredNotification[]> {
    return this.appended;
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

test("listing returns retained notifications newest first", async () => {
  const filters: string[] = [];
  const client = {
    createTable: async () => undefined,
    listEntities: (options: { queryOptions: { filter: string } }) => {
      filters.push(options.queryOptions.filter);
      return {
        async *[Symbol.asyncIterator]() {
          yield { id: "old", body: "older", sentAt: 1, title: "Custom" };
          yield { id: "new", body: "newer", sentAt: 2 };
          yield { id: "broken", body: "dropped" };
        },
      };
    },
  };
  const store = new AzureTableNotificationHistoryStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationHistoryStore
    >[0],
  );

  assert.deepEqual(await store.list(NOW, 7), [
    { id: "new", title: "Notification CLI", body: "newer", sentAt: 2 },
    { id: "old", title: "Custom", body: "older", sentAt: 1 },
  ]);
  assert.match(filters[0] ?? "", /PartitionKey ge '2026-03-08'/);
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
      list: async () => [],
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
