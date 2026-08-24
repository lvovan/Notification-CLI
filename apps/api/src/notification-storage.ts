import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import { ConfigurationError } from "./configuration.js";
import {
  createTableClient,
  DAY_MS,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";

export const NOTIFICATION_HISTORY_TABLE = "NotificationHistory";
export const RETENTION_DAYS_ENV = "NOTIFICATION_CLI_RETENTION_DAYS";
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_NOTIFICATION_PAGE_LIMIT = 5;
export const MAX_NOTIFICATION_PAGE_LIMIT = 50;
const MAX_RETENTION_DAYS = 365;
const DELETE_CONCURRENCY = 20;

export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  sentAt: number;
}

export interface NotificationPage {
  notifications: StoredNotification[];
  nextCursor: string | null;
}

export interface NotificationListOptions {
  limit?: number;
  cursor?: string;
}

export interface NotificationHistoryStore {
  append(userKey: string, notification: StoredNotification): Promise<void>;
  list(
    userKey: string,
    now: Date,
    retentionDays: number,
    options?: NotificationListOptions,
  ): Promise<NotificationPage>;
  prune(userKey: string, now: Date, retentionDays: number): Promise<number>;
}

/**
 * Widest inverted timestamp we ever store, i.e. the value produced for
 * sentAt 0. Every realistic epoch-millisecond timestamp (year 2286 and
 * earlier) subtracts to a non-negative number that fits in 13 digits, so the
 * inverted value is always exactly INVERT_WIDTH characters wide.
 */
const INVERT_BASE = 9_999_999_999_999;
const INVERT_WIDTH = 13;

/** Cursor shape: 13 zero-padded digits, a hyphen, then a whitespace-free id. */
const CURSOR_PATTERN = /^\d{13}-\S+$/;

export class NotificationCursorError extends Error {}

export function parseRetentionDays(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_RETENTION_DAYS;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
    throw new ConfigurationError(
      RETENTION_DAYS_ENV,
      `${RETENTION_DAYS_ENV} must be a whole number of days between 1 and ${MAX_RETENTION_DAYS}.`,
    );
  }
  return days;
}

/**
 * Instant at which retention expires. A notification is retained while it is
 * strictly newer than this cutoff and prunable once it is at or before it.
 * Retention is now exact (millisecond) rather than day-granular, and both
 * list() and prune() derive their bound from this one helper so a notification
 * is never listed after it becomes prunable, nor pruned while still listable.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** Fixed-width inverted timestamp; larger sentAt yields a smaller string. */
function invertedValue(sentAt: number): string {
  return (INVERT_BASE - sentAt).toString().padStart(INVERT_WIDTH, "0");
}

function notificationRowKey(sentAt: number, id: string): string {
  return `${invertedValue(sentAt)}-${id}`;
}

/**
 * Row-key bound separating retained rows from prunable rows. Because inversion
 * REVERSES the ordering (ascending row keys are newest-first), the bound for a
 * notification sent exactly at the cutoff is `${invertedValue(cutoff)}-`:
 *   - a retained row (sentAt > cutoff) has a smaller inverted value, so its
 *     row key sorts BEFORE the bound -> `RowKey lt bound`.
 *   - a prunable row (sentAt <= cutoff) has an inverted value >= the cutoff's,
 *     and any real row appends a non-empty id after the trailing hyphen, so it
 *     sorts AT OR AFTER the bound -> `RowKey ge bound`.
 * The two comparisons are exact complements, so listing and pruning agree on
 * every boundary notification.
 */
function retentionBound(now: Date, retentionDays: number): string {
  return `${invertedValue(retentionCutoff(now, retentionDays).getTime())}-`;
}

export function notificationCursor(notification: StoredNotification): string {
  return notificationRowKey(notification.sentAt, notification.id);
}

export function parseNotificationCursor(value: string): string {
  if (!CURSOR_PATTERN.test(value)) {
    throw new NotificationCursorError("before cursor is malformed.");
  }
  return value;
}

export class AzureTableNotificationHistoryStore
  implements NotificationHistoryStore
{
  constructor(private readonly client: TableClient) {}

  async append(userKey: string, notification: StoredNotification): Promise<void> {
    await ensureTable(this.client);
    const entity: TableEntity<StoredNotification> = {
      partitionKey: userKey,
      // The inverted timestamp makes ascending row-key order newest-first, and
      // the unique id keeps same-millisecond sends from overwriting each other.
      rowKey: notificationRowKey(notification.sentAt, notification.id),
      ...notification,
    };
    await this.client.createEntity(entity);
  }

  async list(
    userKey: string,
    now: Date,
    retentionDays: number,
    options: NotificationListOptions = {},
  ): Promise<NotificationPage> {
    await ensureTable(this.client);
    const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_LIMIT;
    const cursor =
      options.cursor === undefined
        ? undefined
        : parseNotificationCursor(options.cursor);
    const bound = retentionBound(now, retentionDays);
    // Ascending row keys are already newest-first, so a single range query
    // (older than the cursor, newer than the cutoff) needs no in-memory sort.
    // `RowKey gt cursor` walks strictly older rows; `RowKey lt bound` keeps
    // retained rows only.
    const filter =
      cursor === undefined
        ? odata`PartitionKey eq ${userKey} and RowKey lt ${bound}`
        : odata`PartitionKey eq ${userKey} and RowKey gt ${cursor} and RowKey lt ${bound}`;

    const page: StoredNotification[] = [];
    const entities = this.client.listEntities<Partial<StoredNotification>>({
      queryOptions: { filter, select: ["id", "title", "body", "sentAt"] },
    });
    // Read at most limit + 1 rows; the extra row only reports whether another
    // page exists, so we stop the iterator instead of draining the partition.
    for await (const entity of entities) {
      if (
        typeof entity.id === "string" &&
        typeof entity.body === "string" &&
        typeof entity.sentAt === "number"
      ) {
        page.push({
          id: entity.id,
          title: entity.title ?? "Notification CLI",
          body: entity.body,
          sentAt: entity.sentAt,
        });
        if (page.length > limit) {
          break;
        }
      }
    }

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
    userKey: string,
    now: Date,
    retentionDays: number,
  ): Promise<number> {
    await ensureTable(this.client);
    // The complement of list()'s bound: everything at or past it is prunable.
    const filter = odata`PartitionKey eq ${userKey} and RowKey ge ${retentionBound(
      now,
      retentionDays,
    )}`;
    const expired: Array<{ partitionKey: string; rowKey: string }> = [];
    const entities = this.client.listEntities<{
      partitionKey?: string;
      rowKey?: string;
    }>({
      queryOptions: { filter, select: ["PartitionKey", "RowKey"] },
    });
    for await (const entity of entities) {
      if (entity.partitionKey && entity.rowKey) {
        expired.push({
          partitionKey: entity.partitionKey,
          rowKey: entity.rowKey,
        });
      }
    }

    let deleted = 0;
    for (
      let index = 0;
      index < expired.length;
      index += DELETE_CONCURRENCY
    ) {
      const batch = expired.slice(index, index + DELETE_CONCURRENCY);
      await Promise.all(
        batch.map(async ({ partitionKey, rowKey }) => {
          try {
            await this.client.deleteEntity(partitionKey, rowKey);
            deleted += 1;
          } catch (error) {
            // A concurrent sweep may have removed the row already.
            if (tableStatusCode(error) !== 404) {
              throw error;
            }
          }
        }),
      );
    }
    return deleted;
  }
}

export function createNotificationHistoryStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationHistoryStore {
  return new AzureTableNotificationHistoryStore(
    createTableClient(env, NOTIFICATION_HISTORY_TABLE),
  );
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateNotificationHistoryStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationHistoryStore | null {
  const client = tryCreateTableClient(env, NOTIFICATION_HISTORY_TABLE);
  return client ? new AzureTableNotificationHistoryStore(client) : null;
}
