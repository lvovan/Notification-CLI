import { odata, type TableClient, type TableEntity } from "@azure/data-tables";
import { endpointKey, userKey } from "./identity.js";
import {
  createTableClient,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";

export const PUSH_SUBSCRIPTIONS_TABLE = "PushSubscriptions";

export interface StoredPushSubscription {
  partitionKey: string;
  rowKey: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: number;
}

export interface PushSubscriptionStore {
  save(identity: string, subscription: PushSubscriptionData): Promise<void>;
  remove(identity: string, endpoint: string): Promise<void>;
  removeStored(subscription: StoredPushSubscription): Promise<void>;
  list(identity: string): Promise<StoredPushSubscription[]>;
}

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export function parsePushSubscription(
  value: unknown,
): PushSubscriptionData | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as {
    endpoint?: unknown;
    expirationTime?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (
    typeof candidate.endpoint !== "string" ||
    candidate.endpoint.length === 0 ||
    candidate.endpoint.length > 4096 ||
    (candidate.expirationTime !== null &&
      candidate.expirationTime !== undefined &&
      (typeof candidate.expirationTime !== "number" ||
        !Number.isFinite(candidate.expirationTime))) ||
    typeof candidate.keys !== "object" ||
    candidate.keys === null ||
    typeof candidate.keys.p256dh !== "string" ||
    candidate.keys.p256dh.length === 0 ||
    candidate.keys.p256dh.length > 1024 ||
    typeof candidate.keys.auth !== "string" ||
    candidate.keys.auth.length === 0 ||
    candidate.keys.auth.length > 1024
  ) {
    return null;
  }

  try {
    const endpoint = new URL(candidate.endpoint);
    if (endpoint.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return {
    endpoint: candidate.endpoint,
    expirationTime:
      typeof candidate.expirationTime === "number"
        ? candidate.expirationTime
        : null,
    keys: {
      p256dh: candidate.keys.p256dh,
      auth: candidate.keys.auth,
    },
  };
}

export class AzureTablePushSubscriptionStore
  implements PushSubscriptionStore
{
  constructor(private readonly client: TableClient) {}

  async save(
    identity: string,
    subscription: PushSubscriptionData,
  ): Promise<void> {
    await ensureTable(this.client);
    const entity: TableEntity = {
      partitionKey: userKey(identity),
      rowKey: endpointKey(subscription.endpoint),
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    };
    if (subscription.expirationTime !== null) {
      entity.expirationTime = subscription.expirationTime;
    }
    await this.client.upsertEntity(entity, "Replace");
  }

  async remove(identity: string, endpoint: string): Promise<void> {
    await ensureTable(this.client);
    try {
      await this.client.deleteEntity(userKey(identity), endpointKey(endpoint));
    } catch (error) {
      if (tableStatusCode(error) !== 404) {
        throw error;
      }
    }
  }

  async removeStored(subscription: StoredPushSubscription): Promise<void> {
    await ensureTable(this.client);
    try {
      await this.client.deleteEntity(
        subscription.partitionKey,
        subscription.rowKey,
      );
    } catch (error) {
      if (tableStatusCode(error) !== 404) {
        throw error;
      }
    }
  }

  async list(identity: string): Promise<StoredPushSubscription[]> {
    await ensureTable(this.client);
    // A single-partition query is the isolation boundary: a browser only ever
    // sees its own endpoints, and we no longer scan the whole table.
    const filter = odata`PartitionKey eq ${userKey(identity)}`;
    const subscriptions: StoredPushSubscription[] = [];
    const entities = this.client.listEntities<StoredPushSubscription>({
      queryOptions: { filter },
    });
    for await (const entity of entities) {
      if (
        typeof entity.endpoint === "string" &&
        typeof entity.p256dh === "string" &&
        typeof entity.auth === "string"
      ) {
        subscriptions.push(entity);
      }
    }
    return subscriptions;
  }
}

export function createPushSubscriptionStore(
  env: NodeJS.ProcessEnv = process.env,
): PushSubscriptionStore {
  return new AzureTablePushSubscriptionStore(
    createTableClient(env, PUSH_SUBSCRIPTIONS_TABLE),
  );
}

/** Returns null when durable push storage is intentionally not configured. */
export function tryCreatePushSubscriptionStore(
  env: NodeJS.ProcessEnv = process.env,
): PushSubscriptionStore | null {
  const client = tryCreateTableClient(env, PUSH_SUBSCRIPTIONS_TABLE);
  return client ? new AzureTablePushSubscriptionStore(client) : null;
}
