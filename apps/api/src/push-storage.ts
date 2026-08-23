import { createHash } from "node:crypto";
import { type TableClient, type TableEntity } from "@azure/data-tables";
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
  list(authorizedIdentities: Iterable<string>): Promise<StoredPushSubscription[]>;
}

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function keyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
      partitionKey: keyHash(identity),
      rowKey: keyHash(subscription.endpoint),
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
      await this.client.deleteEntity(keyHash(identity), keyHash(endpoint));
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

  async list(
    authorizedIdentities: Iterable<string>,
  ): Promise<StoredPushSubscription[]> {
    await ensureTable(this.client);
    const authorizedPartitions = new Set(
      Array.from(authorizedIdentities, keyHash),
    );
    const subscriptions: StoredPushSubscription[] = [];
    for await (const entity of this.client.listEntities<StoredPushSubscription>()) {
      if (
        authorizedPartitions.has(entity.partitionKey) &&
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
