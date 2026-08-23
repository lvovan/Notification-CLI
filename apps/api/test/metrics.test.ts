import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { fanOutNotification } from "../src/fanout.js";
import { handleMetricsRequest } from "../src/metrics.js";
import {
  AzureTableNotificationMetricsStore,
  countWindows,
  tryCreateNotificationMetricsStore,
  type NotificationCounts,
  type NotificationMetricsStore,
} from "../src/metrics-storage.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const authorizedEnv = { AUTHORIZED_USERS: "user@example.com" };

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
  headers: Record<string, string> = {
    "x-ms-client-principal": principalHeader(),
  },
): HttpRequest {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

class MemoryMetricsStore implements NotificationMetricsStore {
  readonly recorded: Date[] = [];

  constructor(private readonly counts_: NotificationCounts) {}

  async record(sentAt: Date): Promise<void> {
    this.recorded.push(sentAt);
  }

  async counts(): Promise<NotificationCounts> {
    return this.counts_;
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

test("recording inserts a unique row and increments the lifetime total", async () => {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ entity: Record<string, unknown>; etag?: string }> = [];
  let totalEntity: { count: number; etag: string } | undefined;
  const client = {
    createTable: async () => undefined,
    createEntity: async (entity: Record<string, unknown>) => {
      if (entity.partitionKey === "totals") {
        if (totalEntity) {
          throw Object.assign(new Error("exists"), { statusCode: 409 });
        }
        totalEntity = { count: entity.count as number, etag: "etag-1" };
        return;
      }
      created.push(entity);
    },
    getEntity: async () => {
      if (!totalEntity) {
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      }
      return totalEntity;
    },
    updateEntity: async (
      entity: Record<string, unknown>,
      _mode: string,
      options?: { etag?: string },
    ) => {
      if (options?.etag !== totalEntity?.etag) {
        throw Object.assign(new Error("conflict"), { statusCode: 412 });
      }
      totalEntity = { count: entity.count as number, etag: "etag-2" };
      updated.push({ entity, ...(options?.etag ? { etag: options.etag } : {}) });
    },
  };
  const store = new AzureTableNotificationMetricsStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationMetricsStore
    >[0],
  );

  await store.record(NOW);
  assert.equal(totalEntity?.count, 1);

  await store.record(new Date(NOW.getTime() + 1));
  assert.equal(totalEntity?.count, 2);
  assert.equal(updated[0]?.etag, "etag-1");

  assert.deepEqual(
    created.map((entity) => entity.partitionKey),
    ["2026-08-23", "2026-08-23"],
  );
  assert.equal(new Set(created.map((entity) => entity.rowKey)).size, 2);
});

test("a lost race on the total is retried instead of losing a count", async () => {
  let etag = "etag-1";
  let count = 5;
  let attempts = 0;
  const client = {
    createTable: async () => undefined,
    createEntity: async () => undefined,
    getEntity: async () => ({ count, etag }),
    updateEntity: async (
      entity: Record<string, unknown>,
      _mode: string,
      options?: { etag?: string },
    ) => {
      attempts += 1;
      if (attempts === 1) {
        // A concurrent send commits first, invalidating our ETag.
        count = 6;
        etag = "etag-2";
        throw Object.assign(new Error("conflict"), { statusCode: 412 });
      }
      count = entity.count as number;
    },
  };
  const store = new AzureTableNotificationMetricsStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationMetricsStore
    >[0],
  );

  await store.record(NOW);
  assert.equal(attempts, 2);
  assert.equal(count, 7);
});

test("the day-key filter excludes the totals partition from window queries", async () => {
  let filter = "";
  const client = {
    createTable: async () => undefined,
    getEntity: async () => ({ count: 12, etag: "etag" }),
    listEntities: (options: { queryOptions: { filter: string } }) => {
      filter = options.queryOptions.filter;
      return {
        async *[Symbol.asyncIterator]() {
          yield { sentAt: NOW.getTime() - 60_000 };
        },
      };
    },
  };
  const store = new AzureTableNotificationMetricsStore(
    client as unknown as ConstructorParameters<
      typeof AzureTableNotificationMetricsStore
    >[0],
  );

  const counts = await store.counts(NOW);
  assert.match(filter, /PartitionKey ge '2026-07-24'/);
  assert.match(filter, /PartitionKey le '2026-08-23'/);
  assert.ok(!filter.includes("totals"));
  assert.deepEqual(counts, {
    last24Hours: 1,
    last7Days: 1,
    last30Days: 1,
    total: 12,
  });
});

test("metrics endpoint requires an authorized browser session", async () => {
  const store = new MemoryMetricsStore({
    last24Hours: 1,
    last7Days: 2,
    last30Days: 3,
    total: 4,
  });

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
    request({ "x-ms-client-principal": principalHeader("other@example.com") }),
    authorizedEnv,
    store,
  );
  assert.equal(unlisted.status, 403);
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

test("fan-out records a metric without letting storage failures break delivery", async () => {
  const store = new MemoryMetricsStore({
    last24Hours: 0,
    last7Days: 0,
    last30Days: 0,
    total: 0,
  });
  const recorded = await fanOutNotification("hello", {
    env: authorizedEnv,
    webPubSub: { sendToAll: async () => undefined },
    metrics: store,
    now: () => NOW,
  });
  assert.equal(recorded.metricRecorded, true);
  assert.deepEqual(store.recorded, [NOW]);

  const degraded = await fanOutNotification("hello", {
    env: authorizedEnv,
    webPubSub: { sendToAll: async () => undefined },
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
  const store = new MemoryMetricsStore({
    last24Hours: 0,
    last7Days: 0,
    last30Days: 0,
    total: 0,
  });

  await assert.rejects(
    fanOutNotification("hello", {
      env: authorizedEnv,
      webPubSub: {
        sendToAll: async () => {
          throw new Error("hub unavailable");
        },
      },
      metrics: store,
    }),
  );
  assert.deepEqual(store.recorded, []);
});
