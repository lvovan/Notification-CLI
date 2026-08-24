import assert from "node:assert/strict";
import test from "node:test";
import type { TableClient } from "@azure/data-tables";
import {
  API_KEY_PREFIX,
  AzureTableApiKeyStore,
  apiKeyHash,
  generateApiKey,
  maskApiKey,
} from "../src/api-key-storage.js";
import { resolveApiKeyOwner } from "../src/api-key.js";
import { userKey } from "../src/identity.js";

const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";
const env = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };
const NOW = new Date("2026-03-15T12:00:00.000Z");

type Entity = Record<string, unknown> & {
  partitionKey: string;
  rowKey: string;
};

function notFound(): Error {
  return Object.assign(new Error("not found"), { statusCode: 404 });
}

/** A table that behaves like Table Storage for the operations the store uses. */
class FakeTable {
  readonly rows = new Map<string, Entity & { etag: string }>();
  private version = 0;
  /** Rows whose delete should silently fail, to model a lost cleanup. */
  readonly undeletable = new Set<string>();

  private id(partitionKey: string, rowKey: string): string {
    return `${partitionKey}/${rowKey}`;
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
    const id = this.id(partitionKey, rowKey);
    if (this.undeletable.has(id)) {
      return;
    }
    if (!this.rows.delete(id)) {
      throw notFound();
    }
  }

  asClient(): TableClient {
    return this as unknown as TableClient;
  }
}

function store(table: FakeTable): AzureTableApiKeyStore {
  return new AzureTableApiKeyStore(table.asClient(), () => NOW);
}

test("a generated key carries the prefix and masks after four random characters", () => {
  const apiKey = generateApiKey();
  assert.ok(apiKey.startsWith(API_KEY_PREFIX));
  assert.ok(apiKey.length > API_KEY_PREFIX.length + 40);
  assert.notEqual(generateApiKey(), generateApiKey());

  const masked = maskApiKey(`${API_KEY_PREFIX}abcdefgh`);
  assert.equal(masked, `${API_KEY_PREFIX}abcd••••`);
  assert.equal(masked.length, `${API_KEY_PREFIX}abcdefgh`.length);
  // Masking after the prefix alone would render identically for every user.
  assert.notEqual(
    maskApiKey(`${API_KEY_PREFIX}abcdefgh`),
    maskApiKey(`${API_KEY_PREFIX}zyxwvuts`),
  );
});

test("a key is minted on first registration and reused afterwards", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const first = await keys.ensure(OWNER);
  assert.equal(first.email, OWNER);
  assert.ok(first.apiKey.startsWith(API_KEY_PREFIX));
  assert.equal(first.createdAt, NOW.getTime());

  const second = await keys.ensure(OWNER);
  assert.equal(second.apiKey, first.apiKey);
  assert.equal(await keys.resolve(first.apiKey), OWNER);
});

test("two accounts registering never share a key", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const mine = await keys.ensure(OWNER);
  const theirs = await keys.ensure(OTHER);

  assert.notEqual(mine.apiKey, theirs.apiKey);
  assert.equal(await keys.resolve(mine.apiKey), OWNER);
  assert.equal(await keys.resolve(theirs.apiKey), OTHER);
});

test("a racing tab adopts the winning key rather than minting a second one", async () => {
  const table = new FakeTable();
  const keys = store(table);
  const winner = await keys.ensure(OWNER);

  // The loser's initial read happens before the winner commits, so it only
  // discovers the conflict when its own create is rejected.
  let firstOwnerRead = true;
  const racing = new AzureTableApiKeyStore(
    new Proxy(table.asClient(), {
      get(target, property) {
        if (property === "getEntity") {
          return async (partitionKey: string, rowKey: string) => {
            if (partitionKey === "user" && firstOwnerRead) {
              firstOwnerRead = false;
              throw notFound();
            }
            return table.getEntity(partitionKey, rowKey);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    () => NOW,
  );

  const adopted = await racing.ensure(OWNER);
  assert.equal(adopted.apiKey, winner.apiKey);
  assert.equal(await keys.resolve(winner.apiKey), OWNER);

  // Exactly one index row survives, so only one key can ever resolve.
  const indexRows = [...table.rows.values()].filter(
    (row) => row.partitionKey === "key",
  );
  assert.equal(indexRows.length, 1);
});

test("cycling invalidates the previous key immediately", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const original = await keys.ensure(OWNER);
  const cycled = await keys.cycle(OWNER);

  assert.notEqual(cycled.apiKey, original.apiKey);
  assert.equal(await keys.resolve(cycled.apiKey), OWNER);
  assert.equal(await keys.resolve(original.apiKey), null);
});

test("a lingering index row cannot resurrect a cycled key", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const original = await keys.ensure(OWNER);
  // Model a cleanup that never lands: the stale index row survives the cycle.
  table.undeletable.add(`key/${apiKeyHash(original.apiKey)}`);
  const cycled = await keys.cycle(OWNER);

  assert.ok(table.rows.has(`key/${apiKeyHash(original.apiKey)}`));
  // The owner row is the single point of truth, so the old key still fails.
  assert.equal(await keys.resolve(original.apiKey), null);
  assert.equal(await keys.resolve(cycled.apiKey), OWNER);
});

test("cycling with no existing key mints one", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const minted = await keys.cycle(OWNER);
  assert.equal(await keys.resolve(minted.apiKey), OWNER);
});

test("resolution rejects unknown, empty, and foreign-looking keys", async () => {
  const table = new FakeTable();
  const keys = store(table);
  await keys.ensure(OWNER);

  for (const candidate of ["", "ncli_unknown", generateApiKey()]) {
    assert.equal(await keys.resolve(candidate), null, candidate);
  }
});

test("a key stops resolving when its owner leaves AUTHORIZED_USERS", async () => {
  const table = new FakeTable();
  const keys = store(table);
  const minted = await keys.ensure(OTHER);
  const request = {
    headers: new Headers({ "x-api-key": minted.apiKey }),
  };

  assert.equal(
    (await resolveApiKeyOwner(request, env, keys)).authorized,
    true,
  );
  // Same key, same store; only the allowlist changed.
  assert.deepEqual(
    await resolveApiKeyOwner(request, { AUTHORIZED_USERS: OWNER }, keys),
    { authorized: false },
  );
  // The key itself is untouched, so re-authorizing restores access.
  assert.equal(
    (await resolveApiKeyOwner(request, env, keys)).authorized,
    true,
  );
});

test("the owner row is keyed by the normalized address", async () => {
  const table = new FakeTable();
  const keys = store(table);

  const minted = await keys.ensure(OWNER);
  assert.ok(table.rows.has(`user/${userKey(OWNER)}`));
  // A differently cased sign-in must land on the same account, not a new one.
  const again = await keys.ensure("  User@Example.COM  ");
  assert.equal(again.apiKey, minted.apiKey);
});
