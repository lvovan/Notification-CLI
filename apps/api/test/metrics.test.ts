import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { fanOutNotification } from "../src/fanout.js";
import { notificationOwner, userKey } from "../src/identity.js";
import { handleMetricsRequest } from "../src/metrics.js";
import {
  countWindows,
  tryCreateNotificationMetricsStore,
  type NotificationCounts,
  type NotificationMetricsStore,
} from "../src/metrics-storage.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";
const authorizedEnv = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };

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
  headers: Record<string, string> = {
    "x-ms-client-principal": principalHeader(),
  },
): HttpRequest {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

const emptyCounts: NotificationCounts = {
  last24Hours: 0,
  last7Days: 0,
  last30Days: 0,
  total: 0,
};

/** Counts per user so a query that forgot to scope itself shows up here. */
class MemoryMetricsStore implements NotificationMetricsStore {
  readonly recorded: Array<{ userKey: string; sentAt: Date }> = [];

  constructor(private readonly byUser: Map<string, NotificationCounts>) {}

  async record(partition: string, sentAt: Date): Promise<void> {
    this.recorded.push({ userKey: partition, sentAt });
  }

  async counts(partition: string): Promise<NotificationCounts> {
    return this.byUser.get(partition) ?? emptyCounts;
  }
}

test("windows count each retention period inclusively", () => {
  const at = (msAgo: number) => NOW.getTime() - msAgo;
  const counts = countWindows(
    [
      at(0),
      at(DAY_MS - 1),
      at(DAY_MS),
      at(DAY_MS + 1),
      at(7 * DAY_MS),
      at(7 * DAY_MS + 1),
      at(30 * DAY_MS),
      at(30 * DAY_MS + 1),
    ],
    NOW,
    99,
  );

  assert.deepEqual(counts, {
    last24Hours: 3,
    last7Days: 5,
    last30Days: 7,
    total: 99,
  });
});

test("future and expired timestamps are excluded from every window", () => {
  assert.deepEqual(
    countWindows([NOW.getTime() + 60_000, NOW.getTime() - 31 * DAY_MS], NOW, 4),
    { last24Hours: 0, last7Days: 0, last30Days: 0, total: 4 },
  );
});

test("metrics endpoint requires an authorized browser session", async () => {
  const store = new MemoryMetricsStore(
    new Map([
      [
        userKey(OWNER),
        { last24Hours: 1, last7Days: 2, last30Days: 3, total: 4 },
      ],
    ]),
  );

  const authorized = await handleMetricsRequest(
    request(),
    authorizedEnv,
    store,
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.jsonBody, {
    last24Hours: 1,
    last7Days: 2,
    last30Days: 3,
    total: 4,
  });
  assert.equal(
    (authorized.headers as Record<string, string>)["Cache-Control"],
    "no-store",
  );

  const anonymous = await handleMetricsRequest(
    request({}),
    authorizedEnv,
    store,
  );
  assert.equal(anonymous.status, 401);

  const unlisted = await handleMetricsRequest(
    request({ "x-ms-client-principal": principalHeader("nobody@example.com") }),
    authorizedEnv,
    store,
  );
  assert.equal(unlisted.status, 403);
});

test("metrics are counted per account, never across accounts", async () => {
  const store = new MemoryMetricsStore(
    new Map([
      [
        userKey(OWNER),
        { last24Hours: 1, last7Days: 1, last30Days: 1, total: 1 },
      ],
      [
        userKey(OTHER),
        { last24Hours: 9, last7Days: 9, last30Days: 9, total: 9 },
      ],
    ]),
  );

  const mine = await handleMetricsRequest(request(), authorizedEnv, store);
  const theirs = await handleMetricsRequest(
    request({ "x-ms-client-principal": principalHeader(OTHER) }),
    authorizedEnv,
    store,
  );

  assert.equal((mine.jsonBody as NotificationCounts).total, 1);
  assert.equal((theirs.jsonBody as NotificationCounts).total, 9);
});

test("metrics endpoint reports 503 when storage is not configured", async () => {
  assert.equal(tryCreateNotificationMetricsStore({}), null);

  const response = await handleMetricsRequest(request(), authorizedEnv, null);
  assert.equal(response.status, 503);
  assert.match(
    (response.jsonBody as { error: string }).error,
    /NOTIFICATION_CLI_STORAGE_CONNECTION_STRING is not configured/,
  );
});

test("fan-out records a metric against the sender without breaking delivery", async () => {
  const store = new MemoryMetricsStore(new Map());
  const recorded = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    webPubSub: { group: () => ({ sendToAll: async () => undefined }) },
    metrics: store,
    now: () => NOW,
  });
  assert.equal(recorded.metricRecorded, true);
  assert.deepEqual(store.recorded, [{ userKey: userKey(OWNER), sentAt: NOW }]);

  const degraded = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    webPubSub: { group: () => ({ sendToAll: async () => undefined }) },
    metrics: {
      record: async () => {
        throw new Error("storage unavailable");
      },
      counts: async () => {
        throw new Error("storage unavailable");
      },
    },
  });
  assert.equal(degraded.webPubSubDelivered, true);
  assert.equal(degraded.metricRecorded, undefined);
  assert.match(degraded.metricError ?? "", /storage unavailable/);
  assert.deepEqual(degraded.errors, []);
});

test("a failed Web PubSub send is not counted as a delivered notification", async () => {
  const store = new MemoryMetricsStore(new Map());

  await assert.rejects(
    fanOutNotification("hello", notificationOwner(OWNER), {
      env: {},
      webPubSub: {
        group: () => ({
          sendToAll: async () => {
            throw new Error("hub unavailable");
          },
        }),
      },
      metrics: store,
    }),
  );
  assert.deepEqual(store.recorded, []);
});
