import { TableClient } from "@azure/data-tables";
import { hasSetting, requireSetting } from "./configuration.js";

export const STORAGE_CONNECTION_STRING_ENV =
  "NOTIFICATION_CLI_STORAGE_CONNECTION_STRING";
export const DAY_MS = 24 * 60 * 60 * 1000;

export function tableStatusCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

/** UTC day key, lexicographically ordered so range queries scan whole days. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const tablesReady = new WeakMap<TableClient, Promise<void>>();

/** Creates the table once per client, tolerating a concurrent creation. */
export function ensureTable(client: TableClient): Promise<void> {
  let pending = tablesReady.get(client);
  if (!pending) {
    pending = client.createTable().then(
      () => undefined,
      (error: unknown) => {
        if (tableStatusCode(error) !== 409) {
          tablesReady.delete(client);
          throw error;
        }
      },
    );
    tablesReady.set(client, pending);
  }
  return pending;
}

export function createTableClient(
  env: NodeJS.ProcessEnv,
  table: string,
): TableClient {
  return TableClient.fromConnectionString(
    requireSetting(env, STORAGE_CONNECTION_STRING_ENV),
    table,
  );
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateTableClient(
  env: NodeJS.ProcessEnv,
  table: string,
): TableClient | null {
  return hasSetting(env, STORAGE_CONNECTION_STRING_ENV)
    ? createTableClient(env, table)
    : null;
}
