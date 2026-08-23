import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import { ConfigurationError } from "./configuration.js";
import {
  createTableClient,
  DAY_MS,
  dayKey,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";

export const NOTIFICATION_HISTORY_TABLE = "NotificationHistory";
export const RETENTION_DAYS_ENV = "NOTIFICATION_CLI_RETENTION_DAYS";
export const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
const MAX_LISTED_NOTIFICATIONS = 200;
const DELETE_CONCURRENCY = 20;

export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  sentAt: number;
}

export interface NotificationHistoryStore {
  append(notification: StoredNotification): Promise<void>;
  list(now: Date, retentionDays: number): Promise<StoredNotification[]>;
  prune(now: Date, retentionDays: number): Promise<number>;
}

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
 * Oldest UTC day still inside the retention window. Retention is day-granular
 * so that listing and pruning always agree on which partitions are retained.
 */
export function retentionCutoffDay(now: Date, retentionDays: number): string {
  return dayKey(new Date(now.getTime() - retentionDays * DAY_MS));
}

export class AzureTableNotificationHistoryStore
  implements NotificationHistoryStore
{
  constructor(private readonly client: TableClient) {}

  async append(notification: StoredNotification): Promise<void> {
    await ensureTable(this.client);
    const entity: TableEntity<StoredNotification> = {
      partitionKey: dayKey(new Date(notification.sentAt)),
      // The timestamp prefix keeps rows ordered within a day and the unique id
      // keeps concurrent sends from overwriting each other.
      rowKey: `${notification.sentAt}-${notification.id}`,
      ...notification,
    };
    await this.client.createEntity(entity);
  }

  async list(
    now: Date,
    retentionDays: number,
  ): Promise<StoredNotification[]> {
    await ensureTable(this.client);
    const filter = odata`PartitionKey ge ${retentionCutoffDay(now, retentionDays)}`;
    const notifications: StoredNotification[] = [];
    const entities = this.client.listEntities<Partial<StoredNotification>>({
      queryOptions: { filter, select: ["id", "title", "body", "sentAt"] },
    });
    for await (const entity of entities) {
      if (
        typeof entity.id === "string" &&
        typeof entity.body === "string" &&
        typeof entity.sentAt === "number"
      ) {
        notifications.push({
          id: entity.id,
          title: entity.title ?? "Notification CLI",
          body: entity.body,
          sentAt: entity.sentAt,
        });
      }
    }
    notifications.sort((left, right) => right.sentAt - left.sentAt);
    return notifications.slice(0, MAX_LISTED_NOTIFICATIONS);
  }

  async prune(now: Date, retentionDays: number): Promise<number> {
    await ensureTable(this.client);
    const filter = odata`PartitionKey lt ${retentionCutoffDay(now, retentionDays)}`;
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
