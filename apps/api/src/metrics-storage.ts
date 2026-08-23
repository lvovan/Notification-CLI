import { randomUUID } from "node:crypto";
import { odata, TableClient, type TableEntity } from "@azure/data-tables";
import { hasSetting, requireSetting } from "./configuration.js";

export const STORAGE_CONNECTION_STRING_ENV =
  "NOTIFICATION_CLI_STORAGE_CONNECTION_STRING";
export const NOTIFICATION_METRICS_TABLE = "NotificationMetrics";

const TOTAL_PARTITION_KEY = "totals";
const TOTAL_ROW_KEY = "all";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const MAX_TOTAL_ATTEMPTS = 5;

export interface NotificationCounts {
  last24Hours: number;
  last7Days: number;
  last30Days: number;
  total: number;
}

export interface NotificationMetricsStore {
  record(sentAt: Date): Promise<void>;
  counts(now: Date): Promise<NotificationCounts>;
}

interface SentNotificationEntity {
  partitionKey: string;
  rowKey: string;
  sentAt: number;
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

/** UTC day key, lexicographically ordered so range queries scan whole days. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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
    if (age < 0 || age > RETENTION_DAYS * DAY_MS) {
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
  private tableReady: Promise<void> | undefined;

  constructor(private readonly client: TableClient) {}

  private ensureTable(): Promise<void> {
    this.tableReady ??= this.client.createTable().then(
      () => undefined,
      (error: unknown) => {
        if (statusCode(error) !== 409) {
          this.tableReady = undefined;
          throw error;
        }
      },
    );
    return this.tableReady;
  }

  async record(sentAt: Date): Promise<void> {
    await this.ensureTable();
    const entity: TableEntity<{ sentAt: number }> = {
      partitionKey: dayKey(sentAt),
      // A unique row key keeps concurrent sends from overwriting each other.
      rowKey: `${sentAt.getTime()}-${randomUUID()}`,
      sentAt: sentAt.getTime(),
    };
    await this.client.createEntity(entity);
    await this.incrementTotal();
  }

  /**
   * Table Storage has no atomic increment, so the lifetime total is updated
   * with an ETag precondition and retried when a concurrent send wins.
   */
  private async incrementTotal(): Promise<void> {
    for (let attempt = 0; attempt < MAX_TOTAL_ATTEMPTS; attempt += 1) {
      try {
        const current = await this.client.getEntity<{ count: number }>(
          TOTAL_PARTITION_KEY,
          TOTAL_ROW_KEY,
        );
        await this.client.updateEntity(
          {
            partitionKey: TOTAL_PARTITION_KEY,
            rowKey: TOTAL_ROW_KEY,
            count: (current.count ?? 0) + 1,
          },
          "Replace",
          { etag: current.etag },
        );
        return;
      } catch (error) {
        const status = statusCode(error);
        if (status === 404) {
          try {
            await this.client.createEntity({
              partitionKey: TOTAL_PARTITION_KEY,
              rowKey: TOTAL_ROW_KEY,
              count: 1,
            });
            return;
          } catch (createError) {
            if (statusCode(createError) !== 409) {
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

  private async readTotal(): Promise<number> {
    try {
      const entity = await this.client.getEntity<{ count: number }>(
        TOTAL_PARTITION_KEY,
        TOTAL_ROW_KEY,
      );
      return typeof entity.count === "number" ? entity.count : 0;
    } catch (error) {
      if (statusCode(error) === 404) {
        return 0;
      }
      throw error;
    }
  }

  async counts(now: Date): Promise<NotificationCounts> {
    await this.ensureTable();
    const oldest = dayKey(new Date(now.getTime() - RETENTION_DAYS * DAY_MS));
    const newest = dayKey(now);
    // Both bounds are day keys, which also excludes the "totals" partition.
    const filter = odata`PartitionKey ge ${oldest} and PartitionKey le ${newest}`;
    const sentAtValues: number[] = [];
    const entities = this.client.listEntities<SentNotificationEntity>({
      queryOptions: { filter, select: ["sentAt"] },
    });
    for await (const entity of entities) {
      if (typeof entity.sentAt === "number") {
        sentAtValues.push(entity.sentAt);
      }
    }
    return countWindows(sentAtValues, now, await this.readTotal());
  }
}

export function createNotificationMetricsStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationMetricsStore {
  return new AzureTableNotificationMetricsStore(
    TableClient.fromConnectionString(
      requireSetting(env, STORAGE_CONNECTION_STRING_ENV),
      NOTIFICATION_METRICS_TABLE,
    ),
  );
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateNotificationMetricsStore(
  env: NodeJS.ProcessEnv = process.env,
): NotificationMetricsStore | null {
  return hasSetting(env, STORAGE_CONNECTION_STRING_ENV)
    ? createNotificationMetricsStore(env)
    : null;
}
