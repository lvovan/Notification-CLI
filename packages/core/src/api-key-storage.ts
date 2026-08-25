import { createHash, randomBytes } from "node:crypto";
import type { TableClient, TableEntity } from "@azure/data-tables";
import {
  createTableClient,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";
import { userKey } from "./identity.js";

export const API_KEYS_TABLE = "ApiKeys";
export const API_KEY_PREFIX = "ncli_";
/** Characters of the random part shown before the key is masked. */
export const API_KEY_VISIBLE_CHARACTERS = 4;

const INDEX_PARTITION_KEY = "key";
const OWNER_PARTITION_KEY = "user";
const MAX_CYCLE_ATTEMPTS = 5;

export interface ApiKeyRecord {
  email: string;
  apiKey: string;
  createdAt: number;
}

export interface ApiKeyStore {
  /** Returns the user's key, minting one the first time they register. */
  ensure(email: string): Promise<ApiKeyRecord>;
  /** Replaces the user's key, invalidating the previous one immediately. */
  cycle(email: string): Promise<ApiKeyRecord>;
  /** Resolves a presented key to its owner's email, or null. */
  resolve(apiKey: string): Promise<string | null>;
}

interface OwnerEntity {
  email?: string;
  apiKey?: string;
  keyHash?: string;
  createdAt?: number;
  etag?: string;
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function apiKeyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Shows the prefix plus the first few random characters, which differ per user,
 * so the masked value still identifies which key is configured.
 */
export function maskApiKey(apiKey: string): string {
  const random = apiKey.startsWith(API_KEY_PREFIX)
    ? apiKey.slice(API_KEY_PREFIX.length)
    : apiKey;
  const visible = random.slice(0, API_KEY_VISIBLE_CHARACTERS);
  const hidden = Math.max(random.length - visible.length, 0);
  return `${apiKey.slice(0, apiKey.length - random.length)}${visible}${"•".repeat(hidden)}`;
}

function ownerEntity(
  email: string,
  apiKey: string,
  createdAt: number,
): TableEntity<{
  email: string;
  apiKey: string;
  keyHash: string;
  createdAt: number;
}> {
  return {
    partitionKey: OWNER_PARTITION_KEY,
    rowKey: userKey(email),
    email,
    apiKey,
    keyHash: apiKeyHash(apiKey),
    createdAt,
  };
}

function indexEntity(email: string, apiKey: string): TableEntity<{ email: string }> {
  return {
    partitionKey: INDEX_PARTITION_KEY,
    rowKey: apiKeyHash(apiKey),
    email,
  };
}

function toRecord(entity: OwnerEntity): ApiKeyRecord | null {
  return typeof entity.email === "string" && typeof entity.apiKey === "string"
    ? {
        email: entity.email,
        apiKey: entity.apiKey,
        createdAt: entity.createdAt ?? 0,
      }
    : null;
}

export class AzureTableApiKeyStore implements ApiKeyStore {
  constructor(
    private readonly client: TableClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async readOwner(email: string): Promise<OwnerEntity | null> {
    try {
      return await this.client.getEntity<OwnerEntity>(
        OWNER_PARTITION_KEY,
        userKey(email),
      );
    } catch (error) {
      if (tableStatusCode(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async ensure(email: string): Promise<ApiKeyRecord> {
    await ensureTable(this.client);
    const existing = await this.readOwner(email);
    const record = existing ? toRecord(existing) : null;
    if (record) {
      return record;
    }

    const apiKey = generateApiKey();
    const createdAt = this.now().getTime();
    await this.client.upsertEntity(indexEntity(email, apiKey), "Replace");
    try {
      await this.client.createEntity(ownerEntity(email, apiKey, createdAt));
    } catch (error) {
      if (tableStatusCode(error) !== 409) {
        throw error;
      }
      // Another tab registered first. Adopt the winning key and drop the index
      // row this attempt created, so only one key can ever resolve.
      await this.deleteIndex(apiKey);
      const winner = await this.readOwner(email);
      const winningRecord = winner ? toRecord(winner) : null;
      if (!winningRecord) {
        throw new Error("Unable to read the API key that was just created.");
      }
      return winningRecord;
    }
    return { email, apiKey, createdAt };
  }

  async cycle(email: string): Promise<ApiKeyRecord> {
    await ensureTable(this.client);
    for (let attempt = 0; attempt < MAX_CYCLE_ATTEMPTS; attempt += 1) {
      const existing = await this.readOwner(email);
      if (!existing) {
        return this.ensure(email);
      }

      const apiKey = generateApiKey();
      const createdAt = this.now().getTime();
      await this.client.upsertEntity(indexEntity(email, apiKey), "Replace");
      try {
        // Replacing the owner row is the moment the previous key stops
        // resolving, because resolution requires the hashes to agree.
        await this.client.updateEntity(
          ownerEntity(email, apiKey, createdAt),
          "Replace",
          existing.etag !== undefined ? { etag: existing.etag } : {},
        );
      } catch (error) {
        await this.deleteIndex(apiKey);
        if (tableStatusCode(error) === 412) {
          continue;
        }
        throw error;
      }

      if (typeof existing.apiKey === "string") {
        await this.deleteIndex(existing.apiKey);
      }
      return { email, apiKey, createdAt };
    }
    throw new Error("Unable to cycle the API key.");
  }

  private async deleteIndex(apiKey: string): Promise<void> {
    try {
      await this.client.deleteEntity(INDEX_PARTITION_KEY, apiKeyHash(apiKey));
    } catch (error) {
      // A stale index row is harmless: resolution still rejects the key
      // because the owner row no longer carries its hash.
      if (tableStatusCode(error) !== 404) {
        throw error;
      }
    }
  }

  async resolve(apiKey: string): Promise<string | null> {
    if (!apiKey) {
      return null;
    }
    await ensureTable(this.client);
    const hash = apiKeyHash(apiKey);
    let email: string;
    try {
      const index = await this.client.getEntity<{ email?: string }>(
        INDEX_PARTITION_KEY,
        hash,
      );
      if (typeof index.email !== "string") {
        return null;
      }
      email = index.email;
    } catch (error) {
      if (tableStatusCode(error) === 404) {
        return null;
      }
      throw error;
    }

    // The owner row decides. A cycled key whose index row outlived the sweep
    // fails here, so cycling takes effect even when cleanup did not.
    const owner = await this.readOwner(email);
    return owner?.keyHash === hash && typeof owner.email === "string"
      ? owner.email
      : null;
  }
}

export function createApiKeyStore(
  env: NodeJS.ProcessEnv = process.env,
  now?: () => Date,
): ApiKeyStore {
  return new AzureTableApiKeyStore(
    createTableClient(env, API_KEYS_TABLE),
    now,
  );
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateApiKeyStore(
  env: NodeJS.ProcessEnv = process.env,
  now?: () => Date,
): ApiKeyStore | null {
  const client = tryCreateTableClient(env, API_KEYS_TABLE);
  return client ? new AzureTableApiKeyStore(client, now) : null;
}
