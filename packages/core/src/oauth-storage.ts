import { createHash, randomBytes } from "node:crypto";
import type { TableClient } from "@azure/data-tables";
import { generateSigningKey, type SigningKey } from "./oauth-jwt.js";
import {
  createTableClient,
  ensureTable,
  tableStatusCode,
  tryCreateTableClient,
} from "./table-storage.js";

export const OAUTH_TABLE = "NotificationOAuth";

const KEY_PARTITION = "key";
const CURRENT_KEY = "current";
const CLIENT_PARTITION = "client";
const CODE_PARTITION = "code";
const REFRESH_PARTITION = "refresh";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthorizationCode {
  clientId: string;
  email: string;
  redirectUri: string;
  /** The S256 code challenge the token request must answer. */
  challenge: string;
  resource: string;
  scope: string;
  exp: number;
}

export interface RefreshGrant {
  clientId: string;
  email: string;
  resource: string;
  scope: string;
  exp: number;
}

export interface OAuthStore {
  /** The active signing key, created on first use. */
  signingKey(): Promise<SigningKey>;
  registerClient(client: OAuthClient): Promise<void>;
  readClient(clientId: string): Promise<OAuthClient | null>;
  saveCode(code: string, grant: AuthorizationCode): Promise<void>;
  /** Redeems a code. A code works exactly once, however it is presented. */
  consumeCode(code: string): Promise<AuthorizationCode | null>;
  saveRefresh(token: string, grant: RefreshGrant): Promise<void>;
  /** Redeems a refresh token, which is rotated on every use. */
  consumeRefresh(token: string): Promise<RefreshGrant | null>;
}

export function secretToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class AzureTableOAuthStore implements OAuthStore {
  private cachedKey: Promise<SigningKey> | undefined;

  constructor(private readonly client: TableClient) {}

  private async read<T extends object>(partitionKey: string, rowKey: string): Promise<T | null> {
    await ensureTable(this.client);
    try {
      return await this.client.getEntity<T>(partitionKey, rowKey);
    } catch (error) {
      if (tableStatusCode(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  signingKey(): Promise<SigningKey> {
    // The key is immutable once created, so caching it removes a read from
    // every token issue and every token validation.
    return (this.cachedKey ??= this.loadOrCreateKey().catch((error: unknown) => {
      this.cachedKey = undefined;
      throw error;
    }));
  }

  private async loadOrCreateKey(): Promise<SigningKey> {
    const stored = await this.readKey();
    if (stored) {
      return stored;
    }

    const created = generateSigningKey();
    await ensureTable(this.client);
    try {
      await this.client.createEntity({
        partitionKey: KEY_PARTITION,
        rowKey: CURRENT_KEY,
        kid: created.kid,
        privateJwk: JSON.stringify(created.privateJwk),
        publicJwk: JSON.stringify(created.publicJwk),
        createdAt: Date.now(),
      });
      return created;
    } catch (error) {
      if (tableStatusCode(error) !== 409) {
        throw error;
      }
      // Another host created the key first; its key is the only valid one.
      const winner = await this.readKey();
      if (!winner) {
        throw new Error("Unable to read the OAuth signing key.");
      }
      return winner;
    }
  }

  private async readKey(): Promise<SigningKey | null> {
    const entity = await this.read<{ kid?: string; privateJwk?: string; publicJwk?: string }>(
      KEY_PARTITION,
      CURRENT_KEY,
    );
    if (!entity?.kid || !entity.privateJwk || !entity.publicJwk) {
      return null;
    }
    return {
      kid: entity.kid,
      privateJwk: JSON.parse(entity.privateJwk) as SigningKey["privateJwk"],
      publicJwk: JSON.parse(entity.publicJwk) as SigningKey["publicJwk"],
    };
  }

  async registerClient(client: OAuthClient): Promise<void> {
    await ensureTable(this.client);
    await this.client.createEntity({
      partitionKey: CLIENT_PARTITION,
      rowKey: client.clientId,
      clientName: client.clientName,
      redirectUris: JSON.stringify(client.redirectUris),
      createdAt: client.createdAt,
    });
  }

  async readClient(clientId: string): Promise<OAuthClient | null> {
    const entity = await this.read<{
      clientName?: string;
      redirectUris?: string;
      createdAt?: number;
    }>(CLIENT_PARTITION, clientId);
    if (!entity?.redirectUris) {
      return null;
    }
    return {
      clientId,
      clientName: entity.clientName ?? "",
      redirectUris: JSON.parse(entity.redirectUris) as string[],
      createdAt: entity.createdAt ?? 0,
    };
  }

  async saveCode(code: string, grant: AuthorizationCode): Promise<void> {
    await ensureTable(this.client);
    await this.client.createEntity({
      partitionKey: CODE_PARTITION,
      rowKey: tokenHash(code),
      ...grant,
    });
  }

  consumeCode(code: string): Promise<AuthorizationCode | null> {
    return this.consume<AuthorizationCode>(CODE_PARTITION, code);
  }

  async saveRefresh(token: string, grant: RefreshGrant): Promise<void> {
    await ensureTable(this.client);
    await this.client.createEntity({
      partitionKey: REFRESH_PARTITION,
      rowKey: tokenHash(token),
      ...grant,
    });
  }

  consumeRefresh(token: string): Promise<RefreshGrant | null> {
    return this.consume<RefreshGrant>(REFRESH_PARTITION, token);
  }

  /**
   * Deletes before returning, so a replayed code or a rotated refresh token
   * cannot be redeemed twice even if two requests arrive at once.
   */
  private async consume<T extends object & { exp: number }>(
    partitionKey: string,
    value: string,
  ): Promise<T | null> {
    const rowKey = tokenHash(value);
    const entity = await this.read<T>(partitionKey, rowKey);
    if (!entity) {
      return null;
    }
    try {
      await this.client.deleteEntity(partitionKey, rowKey);
    } catch (error) {
      if (tableStatusCode(error) !== 404) {
        throw error;
      }
      return null;
    }
    return entity.exp * 1000 > Date.now() ? entity : null;
  }
}

export function createOAuthStore(env: NodeJS.ProcessEnv = process.env): OAuthStore {
  return new AzureTableOAuthStore(createTableClient(env, OAUTH_TABLE));
}

/** Returns null when the shared storage account is not configured. */
export function tryCreateOAuthStore(env: NodeJS.ProcessEnv = process.env): OAuthStore | null {
  const client = tryCreateTableClient(env, OAUTH_TABLE);
  return client ? new AzureTableOAuthStore(client) : null;
}
