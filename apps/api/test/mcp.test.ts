import assert from "node:assert/strict";
import test from "node:test";
import type { CoreRequest } from "@notification-cli/core/http";
import type { ApiKeyRecord, ApiKeyStore } from "@notification-cli/core/api-key-storage";
import { resolveApiKeyOwner } from "@notification-cli/core/api-key";
import { FanoutError, type FanoutReport } from "@notification-cli/core/fanout";
import { userKey } from "@notification-cli/core/identity";
import { handleMcpRequest } from "@notification-cli/core/mcp";
import { handleNotifyRequest } from "@notification-cli/core/notify";
import { handleWhoamiRequest } from "@notification-cli/core/whoami";

const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";
const OWNER_KEY = "ncli_owner-key";
const OTHER_KEY = "ncli_other-key";
const env = {};

/** Minimal stand-in; the real store's lifecycle is covered in api-key.test.ts. */
class MemoryApiKeyStore implements ApiKeyStore {
  constructor(private readonly keys = new Map<string, string>()) {}

  async ensure(email: string): Promise<ApiKeyRecord> {
    const apiKey = `ncli_${email}`;
    this.keys.set(apiKey, email);
    return { email, apiKey, createdAt: 0 };
  }

  async cycle(email: string): Promise<ApiKeyRecord> {
    for (const [key, owner] of this.keys) {
      if (owner === email) {
        this.keys.delete(key);
      }
    }
    return this.ensure(email);
  }

  async resolve(apiKey: string): Promise<string | null> {
    return this.keys.get(apiKey) ?? null;
  }
}

function keyStore(): ApiKeyStore {
  return new MemoryApiKeyStore(
    new Map([
      [OWNER_KEY, OWNER],
      [OTHER_KEY, OTHER],
    ]),
  );
}

function withHeaders(values: Record<string, string>) {
  return {
    headers: new Headers(values),
    url: "https://notify.example.com/api/mcp",
  } as Pick<CoreRequest, "headers" | "url">;
}

const report: FanoutReport = {
  webPubSubDelivered: true,
  pushConfigured: true,
  pushAttempted: 1,
  pushDelivered: 1,
  pushRemoved: 0,
  pushFailed: 0,
  errors: [],
};

test("a key resolves to its own account and nobody else's", async () => {
  const store = keyStore();

  const owner = await resolveApiKeyOwner(
    withHeaders({ "x-api-key": OWNER_KEY }),
    env,
    store,
  );
  assert.deepEqual(owner, {
    authorized: true,
    owner: { email: OWNER, userKey: userKey(OWNER) },
  });

  const other = await resolveApiKeyOwner(
    withHeaders({ "x-api-key": OTHER_KEY }),
    env,
    store,
  );
  assert.equal(
    other.authorized && other.owner.email,
    OTHER,
    "each key must resolve to its own owner",
  );
});

test("unknown and missing keys are rejected", async () => {
  const store = keyStore();
  for (const headers of [
    { "x-api-key": "ncli_not-a-key" },
    {},
    { authorization: "Bearer ncli_not-a-key" },
    { "x-authorization": "Bearer ncli_not-a-key" },
    { authorization: `Basic ${OWNER_KEY}` },
  ]) {
    assert.deepEqual(
      await resolveApiKeyOwner(withHeaders(headers), env, store),
      { authorized: false },
    );
  }
});

// MCP clients default to sending the key as a token rather than in a custom
// header. Static Web Apps overwrites Authorization with its own platform token,
// so x-authorization is the one that survives to the function; both are
// accepted because the API is only behind that proxy in this deployment.
test("a token is accepted from either scheme header", async () => {
  const store = keyStore();
  const expected = {
    authorized: true,
    owner: { email: OWNER, userKey: userKey(OWNER) },
  };

  for (const name of ["authorization", "x-authorization"]) {
    assert.deepEqual(
      await resolveApiKeyOwner(
        withHeaders({ [name]: `Bearer ${OWNER_KEY}` }),
        env,
        store,
      ),
      expected,
      name,
    );
  }

  // The platform token left in Authorization must not shadow a real key.
  assert.deepEqual(
    await resolveApiKeyOwner(
      withHeaders({
        "x-authorization": `Bearer ${OWNER_KEY}`,
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.platform.token",
      }),
      env,
      store,
    ),
    expected,
  );
});
test("a key that resolves to any email is accepted without an allowlist", async () => {
  const store = keyStore();
  assert.deepEqual(
    await resolveApiKeyOwner(
      withHeaders({ "x-api-key": OTHER_KEY }),
      env,
      store,
    ),
    {
      authorized: true,
      owner: { email: OTHER, userKey: userKey(OTHER) },
    },
  );
});

test("one key authorizes the CLI, the MCP endpoint, and whoami", async () => {
  const store = keyStore();
  const senders: string[] = [];
  const fanOut = async (message: string, owner: { email: string }) => {
    senders.push(`${owner.email}:${message}`);
    return report;
  };

  const notified = await handleNotifyRequest(
    {
      headers: new Headers({ "x-api-key": OWNER_KEY }),
      url: "https://notify.example.com/api/mcp",
      json: async () => ({ message: "hello" }),
    } as unknown as CoreRequest,
    env,
    fanOut,
    undefined,
    store,
  );
  assert.equal(notified.status, 200);

  const called = await handleMcpRequest(
    toolCallRequest("hello", OWNER_KEY),
    env,
    fanOut,
    undefined,
    store,
  );
  assert.equal(called.status ?? 200, 200);

  const whoami = await handleWhoamiRequest(
    withHeaders({ "x-api-key": OWNER_KEY }) as CoreRequest,
    env,
    store,
  );
  assert.equal(whoami.status, 200);
  assert.deepEqual(whoami.jsonBody, { email: OWNER });

  assert.deepEqual(senders, [`${OWNER}:hello`, `${OWNER}:hello`]);
});

test("the sender is taken from the key, never from the request body", async () => {
  const store = keyStore();
  let recipient = "";
  await handleNotifyRequest(
    {
      headers: new Headers({ "x-api-key": OTHER_KEY }),
      url: "https://notify.example.com/api/mcp",
      // A caller trying to send as, or on behalf of, somebody else.
      json: async () => ({ message: "hello", email: OWNER, user: OWNER }),
    } as unknown as CoreRequest,
    env,
    async (_message, owner) => {
      recipient = owner.email;
      return report;
    },
    undefined,
    store,
  );
  assert.equal(recipient, OTHER);
});

test("sender endpoints reject an unknown key", async () => {
  const store = keyStore();
  const notified = await handleNotifyRequest(
    {
      headers: new Headers({ "x-api-key": "ncli_nope" }),
      url: "https://notify.example.com/api/mcp",
      json: async () => ({ message: "hello" }),
    } as unknown as CoreRequest,
    env,
    async () => report,
    undefined,
    store,
  );
  assert.equal(notified.status, 401);

  const whoami = await handleWhoamiRequest(
    withHeaders({ "x-api-key": "ncli_nope" }) as CoreRequest,
    env,
    store,
  );
  assert.equal(whoami.status, 401);
});

function toolCallRequest(message: string, apiKey: string): CoreRequest {
  return {
    headers: new Headers({ "x-api-key": apiKey }),
      url: "https://notify.example.com/api/mcp",
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_notification",
        arguments: { message },
      },
    }),
  } as unknown as CoreRequest;
}

test("send_notification uses shared fan-out and reports partial delivery", async () => {
  const store = keyStore();
  let delivered = "";
  const accepted = await handleMcpRequest(
    toolCallRequest(" hello ", OWNER_KEY),
    env,
    async (message) => {
      delivered = message;
      return report;
    },
    undefined,
    store,
  );
  assert.equal(delivered, "hello");
  assert.equal(
    (
      accepted.jsonBody as {
        result: { content: Array<{ text: string }> };
      }
    ).result.content[0]?.text,
    "Notification sent.",
  );

  const failedReport: FanoutReport = {
    ...report,
    pushDelivered: 0,
    pushFailed: 1,
    errors: ["Web Push delivery failed"],
  };
  const partial = await handleMcpRequest(
    toolCallRequest("hello", OWNER_KEY),
    env,
    async () => {
      throw new FanoutError(failedReport);
    },
    undefined,
    store,
  );
  const result = (
    partial.jsonBody as {
      result: { isError: boolean; content: Array<{ text: string }> };
    }
  ).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /incomplete/);
});
