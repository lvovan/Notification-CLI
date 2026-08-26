import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TableClient } from "@azure/data-tables";
import { userKey } from "@notification-cli/core/identity";
import {
  AzureTableNotificationMetricsStore,
  type NotificationMetricsStore,
} from "@notification-cli/core/metrics-storage";
import {
  AzureTableNotificationHistoryStore,
  NotificationCursorError,
  notificationCursor,
  parseNotificationCursor,
  type NotificationHistoryStore,
  type StoredNotification,
} from "@notification-cli/core/notification-storage";
import {
  AzureTablePushSubscriptionStore,
  type PushSubscriptionData,
  type PushSubscriptionStore,
} from "@notification-cli/core/push-storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-24T12:00:00.000Z");
const OWNER = userKey("user@example.com");
const OTHER = userKey("someone.else@example.com");

type Entity = Record<string, unknown> & {
  partitionKey: string;
  rowKey: string;
};

function notFound(): Error {
  return Object.assign(new Error("not found"), { statusCode: 404 });
}

/**
 * A table that behaves like Azure Table Storage for the operations the stores
 * use. listEntities yields rows ASCENDING by (PartitionKey, RowKey) exactly as
 * the service does and never sorts on any other field, so a newest-first
 * result can only come from the inverted row key, not from an in-memory sort.
 */
class FakeTable {
  readonly rows = new Map<string, Entity & { etag: string }>();
  private version = 0;

  private id(partitionKey: string, rowKey: string): string {
    return `${partitionKey}\u0000${rowKey}`;
  }

  async createTable(): Promise<void> {}

  async getEntity<T>(partitionKey: string, rowKey: string): Promise<T> {
    const row = this.rows.get(this.id(partitionKey, rowKey));
    if (!row) {
      throw notFound();
    }
    return { ...row } as T;
  }

  async createEntity(entity: Entity): Promise<void> {
    const id = this.id(entity.partitionKey, entity.rowKey);
    if (this.rows.has(id)) {
      throw Object.assign(new Error("conflict"), { statusCode: 409 });
    }
    this.version += 1;
    this.rows.set(id, { ...entity, etag: `etag-${this.version}` });
  }

  async upsertEntity(entity: Entity): Promise<void> {
    this.version += 1;
    this.rows.set(this.id(entity.partitionKey, entity.rowKey), {
      ...entity,
      etag: `etag-${this.version}`,
    });
  }

  async updateEntity(
    entity: Entity,
    _mode: string,
    options?: { etag?: string },
  ): Promise<void> {
    const id = this.id(entity.partitionKey, entity.rowKey);
    const existing = this.rows.get(id);
    if (!existing) {
      throw notFound();
    }
    if (options?.etag !== undefined && options.etag !== existing.etag) {
      throw Object.assign(new Error("precondition failed"), {
        statusCode: 412,
      });
    }
    this.version += 1;
    this.rows.set(id, { ...entity, etag: `etag-${this.version}` });
  }

  async deleteEntity(partitionKey: string, rowKey: string): Promise<void> {
    if (!this.rows.delete(this.id(partitionKey, rowKey))) {
      throw notFound();
    }
  }

  listEntities<T>(options?: {
    queryOptions?: { filter?: string };
  }): AsyncIterable<T> {
    const filter = options?.queryOptions?.filter;
    // Snapshot in service order so deletes during iteration are safe.
    const matching = [...this.rows.values()]
      .filter((row) => matchesFilter(row, filter))
      .sort((left, right) =>
        left.partitionKey === right.partitionKey
          ? compare(left.rowKey, right.rowKey)
          : compare(left.partitionKey, right.partitionKey),
      );
    return {
      async *[Symbol.asyncIterator]() {
        for (const row of matching) {
          yield { ...row } as T;
        }
      },
    };
  }

  asClient(): TableClient {
    return this as unknown as TableClient;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Evaluates the subset of OData the stores build: `Field op 'value'` clauses. */
function matchesFilter(entity: Entity, filter: string | undefined): boolean {
  if (!filter) {
    return true;
  }
  return filter.split(" and ").every((clause) => {
    const match = /^(\w+) (eq|gt|ge|lt|le) '(.*)'$/.exec(clause.trim());
    if (!match) {
      throw new Error(`unsupported filter clause: ${clause}`);
    }
    const field = match[1] === "PartitionKey" ? "partitionKey" : "rowKey";
    const actual = String(entity[field]);
    const value = match[3]!.replace(/''/g, "'");
    switch (match[2]) {
      case "eq":
        return actual === value;
      case "gt":
        return actual > value;
      case "ge":
        return actual >= value;
      case "lt":
        return actual < value;
      default:
        return actual <= value;
    }
  });
}

function historyStore(table = new FakeTable()): {
  store: NotificationHistoryStore;
  table: FakeTable;
} {
  return {
    store: new AzureTableNotificationHistoryStore(table.asClient()),
    table,
  };
}

function metricsStore(table = new FakeTable()): NotificationMetricsStore {
  return new AzureTableNotificationMetricsStore(table.asClient());
}

function pushStore(table = new FakeTable()): PushSubscriptionStore {
  return new AzureTablePushSubscriptionStore(table.asClient());
}

function notification(id: string, sentAt: number): StoredNotification {
  return { id, title: "Notification CLI", body: id, sentAt };
}

async function drain(
  store: NotificationHistoryStore,
  partition: string,
  now = NOW,
  retentionDays = 30,
  limit = 5,
): Promise<StoredNotification[]> {
  const all: StoredNotification[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list(partition, now, retentionDays, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    all.push(...page.notifications);
    if (page.nextCursor === null) {
      return all;
    }
    cursor = page.nextCursor;
  }
}

function subscription(endpoint: string): PushSubscriptionData {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` },
  };
}

test("history and metrics stay isolated per user", async () => {
  const { store } = historyStore();
  await store.append(OWNER, notification("mine-1", NOW.getTime() - 1_000));
  await store.append(OWNER, notification("mine-2", NOW.getTime() - 2_000));
  await store.append(OTHER, notification("theirs", NOW.getTime() - 1_500));

  assert.deepEqual(
    (await drain(store, OWNER)).map((entry) => entry.id),
    ["mine-1", "mine-2"],
  );
  assert.deepEqual(
    (await drain(store, OTHER)).map((entry) => entry.id),
    ["theirs"],
  );

  // Pruning one account never touches another's rows.
  await store.prune(OWNER, new Date(NOW.getTime() + 40 * DAY_MS), 1);
  assert.deepEqual(await drain(store, OWNER), []);
  assert.deepEqual(
    (await drain(store, OTHER)).map((entry) => entry.id),
    ["theirs"],
  );

  const metrics = metricsStore();
  await metrics.record(OWNER, new Date(NOW.getTime() - 1_000));
  await metrics.record(OWNER, new Date(NOW.getTime() - 2_000));
  await metrics.record(OTHER, new Date(NOW.getTime() - 1_000));

  assert.equal((await metrics.counts(OWNER, NOW)).total, 2);
  assert.equal((await metrics.counts(OTHER, NOW)).total, 1);
  assert.equal((await metrics.counts(OWNER, NOW)).last24Hours, 2);
  assert.equal((await metrics.counts(OTHER, NOW)).last24Hours, 1);
});

test("push subscriptions are listed only within a single account", async () => {
  const store = pushStore();
  await store.save("user@example.com", subscription("https://push.example/a"));
  await store.save("user@example.com", subscription("https://push.example/b"));
  await store.save("other@example.com", subscription("https://push.example/c"));

  const mine = await store.list("user@example.com");
  assert.deepEqual(
    mine.map((entry) => entry.endpoint).sort(),
    ["https://push.example/a", "https://push.example/b"],
  );
  const theirs = await store.list("other@example.com");
  assert.deepEqual(
    theirs.map((entry) => entry.endpoint),
    ["https://push.example/c"],
  );

  // A differently cased sign-in normalizes to the same partition.
  assert.equal((await store.list("USER@example.com")).length, 2);
});

test("inverted row keys return newest-first with no in-memory sort", async () => {
  const { store } = historyStore();
  const base = NOW.getTime();
  // Appended out of order; only the inverted row key can restore newest-first.
  for (const offset of [3_000, 0, 5_000, 1_000, 2_000, 4_000]) {
    await store.append(OWNER, notification(`n-${offset}`, base - offset));
  }

  const listed = await drain(store, OWNER, NOW, 30, 10);
  assert.deepEqual(
    listed.map((entry) => entry.sentAt),
    [base, base - 1_000, base - 2_000, base - 3_000, base - 4_000, base - 5_000],
  );
});

test("paging returns strictly older items with no gaps or duplicates", async () => {
  const { store } = historyStore();
  const base = NOW.getTime();
  const expected: StoredNotification[] = [];
  for (let index = 0; index < 12; index += 1) {
    const entry = notification(
      `n-${index.toString().padStart(2, "0")}`,
      base - index,
    );
    expected.push(entry);
    await store.append(OWNER, entry);
  }

  const pages: StoredNotification[][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    const result = await store.list(OWNER, NOW, 30, {
      limit: 5,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    pages.push(result.notifications);
    // nextCursor is null only on the final page.
    assert.equal(result.nextCursor === null, page === 2);
    cursor = result.nextCursor ?? undefined;
  }

  assert.deepEqual(pages.flat(), expected);
  const ids = pages.flat().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("same-millisecond notifications page across the id tiebreak", async () => {
  const { store } = historyStore();
  const sentAt = NOW.getTime();
  for (const id of ["a", "b", "c"]) {
    await store.append(OWNER, notification(id, sentAt));
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page += 1) {
    const result = await store.list(OWNER, NOW, 30, {
      limit: 1,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    seen.push(...result.notifications.map((entry) => entry.id));
    if (result.nextCursor === null) {
      break;
    }
    cursor = result.nextCursor;
  }

  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(new Set(seen).size, 3);
});

test("list and prune agree exactly on the retention cutoff", async () => {
  const retentionDays = 7;
  const cutoffMs = NOW.getTime() - retentionDays * DAY_MS;

  const atBoundary = async (id: string, sentAt: number, prunable: boolean) => {
    const { store, table } = historyStore();
    await store.append(OWNER, notification(id, sentAt));
    const listed = (await drain(store, OWNER, NOW, retentionDays, 10)).map(
      (entry) => entry.id,
    );
    const deleted = await store.prune(OWNER, NOW, retentionDays);
    if (prunable) {
      assert.deepEqual(listed, [], `${id} must not be listed`);
      assert.equal(deleted, 1, `${id} must be pruned`);
      assert.equal(table.rows.size, 0);
    } else {
      assert.deepEqual(listed, [id], `${id} must be listed`);
      assert.equal(deleted, 0, `${id} must not be pruned`);
      assert.equal(table.rows.size, 1);
    }
  };

  // Exactly at the cutoff is prunable and never listed; one ms newer is
  // retained and never pruned. The two decisions are exact complements.
  await atBoundary("at-cutoff", cutoffMs, true);
  await atBoundary("just-inside", cutoffMs + 1, false);
  await atBoundary("just-outside", cutoffMs - 1, true);
});

test("a per-user lifetime total survives history aging and never leaks", async () => {
  const metrics = metricsStore();
  // Two sends inside the window and one far outside it.
  await metrics.record(OWNER, new Date(NOW.getTime() - 1_000));
  await metrics.record(OWNER, new Date(NOW.getTime() - 3 * DAY_MS));
  await metrics.record(OWNER, new Date(NOW.getTime() - 90 * DAY_MS));
  await metrics.record(OTHER, new Date(NOW.getTime() - 1_000));

  const owner = await metrics.counts(OWNER, NOW);
  // The lifetime total counts every send even though the aged one falls out of
  // the 30-day window.
  assert.equal(owner.total, 3);
  assert.equal(owner.last30Days, 2);
  assert.equal(owner.last7Days, 2);
  assert.equal(owner.last24Hours, 1);

  const other = await metrics.counts(OTHER, NOW);
  assert.equal(other.total, 1);
});

test("parseNotificationCursor rejects malformed cursors", () => {
  const valid = notificationCursor(notification("abc-def", NOW.getTime()));
  assert.equal(parseNotificationCursor(valid), valid);

  for (const invalid of [
    "",
    "not-a-cursor",
    "123-abc",
    "12345678901234-abc",
    "1234567890123abc",
    `${"1".repeat(13)}- abc`,
    `${"1".repeat(13)}-`,
  ]) {
    assert.throws(
      () => parseNotificationCursor(invalid),
      (error: unknown) => error instanceof NotificationCursorError,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

test("clearing empties one partition regardless of retention", async () => {
  const { store, table } = historyStore();
  // Spread across the retention boundary: a clear is not a prune, so an entry
  // far older than the window must go too.
  await store.append(OWNER, notification("fresh", NOW.getTime()));
  await store.append(OWNER, notification("stale", NOW.getTime() - 90 * DAY_MS));
  await store.append(OTHER, notification("theirs", NOW.getTime()));

  const deleted = await store.clear(OWNER);

  assert.equal(deleted, 2);
  assert.deepEqual(await drain(store, OWNER), []);
  assert.deepEqual(
    (await drain(store, OTHER)).map((entry) => entry.id),
    ["theirs"],
    "clearing must never reach another partition",
  );
  assert.equal(table.rows.size, 1);
});

test("clearing an empty partition is a no-op", async () => {
  const { store } = historyStore();

  assert.equal(await store.clear(OWNER), 0);
});
