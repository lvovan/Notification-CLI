import { randomUUID } from "node:crypto";
import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import {
  createTableClient,
  DAY_MS,
  dayKey,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";

export const NOTIFICATION_METRICS_TABLE = "NotificationMetrics";

const TOTAL_ROW_KEY = "totals";
const METRICS_WINDOW_DAYS = 30;
const MAX_TOTAL_ATTEMPTS = 5;

export interface NotificationCounts {
  last24Hours: number;
  last7Days: number;
  last30Days: number;
  total: number;
}

export interface NotificationMetricsStore {
  record(userKey: string, sentAt: Date): Promise<void>;
  counts(userKey: string, now: Date): Promise<NotificationCounts>;
}

interface SentNotificationEntity {
  partitionKey: string;
  rowKey: string;
  sentAt: number;
}

export function countWindows(
  sentAtValues: Iterable<number>,
  now: Date,
  total: number,
): NotificationCounts {
  const nowMs = now.getTime();
  const counts = { last24Hours: 0, last7Days: 0, last30Days: 0, total };
  for (const sentAt of sentAtValues) {
    const age = nowMs - sentAt;
    if (age < 0 || age > METRICS_WINDOW_DAYS * DAY_MS) {
      continue;
    }
    counts.last30Days += 1;
    if (age <= 7 * DAY_MS) {
      counts.last7Days += 1;
    }
    if (age <= DAY_MS) {
      counts.last24Hours += 1;
    }
  }
  return counts;
}

export class AzureTableNotificationMetricsStore
  implements NotificationMetricsStore
{
  constructor(private readonly client: TableClient) {}

  async record(userKey: string, sentAt: Date): Promise<void> {
    await ensureTable(this.client);
    const entity: TableEntity<{ sentAt: number }> = {
      partitionKey: userKey,
      // A readable day-prefixed key keeps counts() a simple range scan, and the
      // unique id keeps concurrent sends from overwriting each other. No
      // inversion is needed: metrics are aggregated, never ordered.
      rowKey: `${dayKey(sentAt)}-${sentAt.getTime()}-${randomUUID()}`,
      sentAt: sentAt.getTime(),
    };
    await this.client.createEntity(entity);
    await this.incrementTotal(userKey);
  }

  /**
   * Table Storage has no atomic increment, so the per-user lifetime total is
   * updated with an ETag precondition and retried when a concurrent send wins.
   */
  private async incrementTotal(userKey: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_TOTAL_ATTEMPTS; attempt += 1) {
      try {
        const current = await this.client.getEntity<{ count: number }>(
          userKey,
          TOTAL_ROW_KEY,
        );
        await this.client.updateEntity(
          {
            partitionKey: userKey,
            rowKey: TOTAL_ROW_KEY,
            count: (current.count ?? 0) + 1,
          },
          "Replace",
          { etag: current.etag },
        );
        return;
      } catch (error) {
        const status = tableStatusCode(error);
        if (status === 404) {
          try {
            await this.client.createEntity({
              partitionKey: userKey,
              rowKey: TOTAL_ROW_KEY,
              count: 1,
            });
            return;
          } catch (createError) {
            if (tableStatusCode(createError) !== 409) {
              throw createError;
            }
          }
        } else if (status !== 412) {
          throw error;
        }
      }
    }
    throw new Error("Unable to update the notification total.");
  }

  private async readTotal(userKey: string): Promise<number> {
    try {
      const entity = await this.client.getEntity<{ count: number }>(
        userKey,
        TOTAL_ROW_KEY,
      );
      return typeof entity.count === "number" ? entity.count : 0;
    } catch (error) {
      if (tableStatusCode(error) === 404) {
        return 0;
      }
      throw error;
    }
  }

  async counts(userKey: string, now: Date): Promise<NotificationCounts> {
    await ensureTable(this.client);
    const oldest = dayKey(
      new Date(now.getTime() - METRICS_WINDOW_DAYS * DAY_MS),
    );
    // Exclusive upper bound: the day AFTER today, so every one of today's rows
    // is included. Day keys start with a digit; the "totals" row starts with
    // 't', which sorts after every digit, so this bound can never scan it.
    const dayAfterNewest = dayKey(new Date(now.getTime() + DAY_MS));
    const filter = odata`PartitionKey eq ${userKey} and RowKey ge ${oldest} and RowKey lt ${dayAfterNewest}`;
    const sentAtValues: number[] = [];
    const entities = this.client.listEntities<SentNotificationEntity>({
      queryOptions: { filter, select: ["sentAt"] },
    });
    for await (const entity of entities) {
      if (typeof entity.sentAt === "number") {
        sentAtValues.push(entity.sentAt);
      }
    }
    return countWindows(sentAtValues, now, await this.readTotal(userKey));
  }
}

export function createNotificationMetricsStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationMetricsStore {
  return new AzureTableNotificationMetricsStore(
    createTableClient(env, NOTIFICATION_METRICS_TABLE),
  );
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateNotificationMetricsStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationMetricsStore | null {
  const client = tryCreateTableClient(env, NOTIFICATION_METRICS_TABLE);
  return client ? new AzureTableNotificationMetricsStore(client) : null;
}
