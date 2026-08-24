import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { handleNegotiateRequest } from "../src/browser.js";
import { fanOutNotification } from "../src/fanout.js";
import { notificationOwner, userGroup, userKey } from "../src/identity.js";
import type { StoredPushSubscription } from "../src/push-storage.js";
import { CLIENT_TOKEN_MINUTES } from "../src/web-pubsub.js";

const OWNER = "user@example.com";
const OTHER = "someone.else@example.com";
const env = { AUTHORIZED_USERS: `${OWNER};${OTHER}` };

function source(name: string): string {
  return readFileSync(resolve(`src/${name}`), "utf8");
}

function signedIn(email: string): HttpRequest {
  return {
    headers: new Headers({
      "x-ms-client-principal": Buffer.from(
        JSON.stringify({
          identityProvider: "aad",
          userId: "user-id",
          userDetails: email,
          userRoles: ["authenticated"],
        }),
      ).toString("base64"),
    }),
  } as HttpRequest;
}

test("an account's identity is a stable, opaque, normalized hash", () => {
  assert.match(userKey(OWNER), /^[0-9a-f]{64}$/);
  assert.equal(userKey(OWNER), userKey("  User@Example.COM  "));
  assert.notEqual(userKey(OWNER), userKey(OTHER));
  assert.equal(userGroup(OWNER), `u-${userKey(OWNER)}`);
  // The group name must not leak the address it was derived from.
  assert.ok(!userGroup(OWNER).includes("@"));
  assert.deepEqual(notificationOwner(" User@Example.COM "), {
    email: OWNER,
    userKey: userKey(OWNER),
  });
});

test("negotiate issues a role-free token scoped to the caller's own group", async () => {
  const issued: Array<{ expirationTimeInMinutes: number; groups: string[] }> =
    [];
  const createClient = () => ({
    getClientAccessToken: async (options: {
      expirationTimeInMinutes: number;
      groups: string[];
    }) => {
      issued.push(options);
      return { url: "wss://example.test/client" };
    },
  });

  await handleNegotiateRequest(signedIn(OWNER), env, createClient);
  await handleNegotiateRequest(signedIn(OTHER), env, createClient);

  assert.deepEqual(
    issued.map((options) => options.groups),
    [[userGroup(OWNER)], [userGroup(OTHER)]],
  );
  assert.equal(issued[0]?.expirationTimeInMinutes, CLIENT_TOKEN_MINUTES);
  // Without roles a connection can neither join another group nor publish.
  for (const options of issued) {
    assert.equal(
      (options as { roles?: string[] }).roles,
      undefined,
      "the client token must never request roles",
    );
  }
});

test("a notification reaches only the sender's own group", async () => {
  const groups: string[] = [];
  const sender = {
    group: (name: string) => {
      groups.push(name);
      return { sendToAll: async () => undefined };
    },
  };

  await fanOutNotification("mine", notificationOwner(OWNER), {
    env: {},
    webPubSub: sender,
  });
  await fanOutNotification("theirs", notificationOwner(OTHER), {
    env: {},
    webPubSub: sender,
  });

  assert.deepEqual(groups, [userGroup(OWNER), userGroup(OTHER)]);
});

test("push delivery targets only the sender's own subscriptions", async () => {
  const devices = new Map<string, StoredPushSubscription[]>([
    [
      OWNER,
      [
        {
          partitionKey: userKey(OWNER),
          rowKey: "mine",
          endpoint: "https://push.example.test/mine",
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      ],
    ],
    [
      OTHER,
      [
        {
          partitionKey: userKey(OTHER),
          rowKey: "theirs",
          endpoint: "https://push.example.test/theirs",
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      ],
    ],
  ]);
  const requested: string[] = [];
  const endpoints: string[] = [];

  await fanOutNotification("mine", notificationOwner(OWNER), {
    env: {},
    webPubSub: { group: () => ({ sendToAll: async () => undefined }) },
    store: {
      save: async () => undefined,
      remove: async () => undefined,
      removeStored: async () => undefined,
      list: async (identity: string) => {
        requested.push(identity);
        return devices.get(identity) ?? [];
      },
    },
    webPush: {
      send: async (subscription) => {
        endpoints.push(subscription.endpoint);
      },
    },
  });

  // The store is asked for one identity, so the other user's devices are never
  // even read, let alone filtered out afterwards.
  assert.deepEqual(requested, [OWNER]);
  assert.deepEqual(endpoints, ["https://push.example.test/mine"]);
});

test("no server code broadcasts to every connection", () => {
  for (const file of ["fanout.ts", "web-pubsub.ts", "browser.ts"]) {
    const contents = source(file);
    // group(...).sendToAll is scoped; a bare client.sendToAll is not.
    assert.ok(
      !/\bclient\.sendToAll\b/.test(contents),
      `${file} must not broadcast to the whole hub`,
    );
    assert.ok(
      !/sendToUser\b/.test(contents),
      `${file} must route through groups, not raw user ids`,
    );
  }
  assert.match(source("fanout.ts"), /sendToUserGroup\(/);
});

test("no read endpoint takes an account identifier from the caller", () => {
  for (const file of ["notifications.ts", "metrics.ts", "push.ts", "apikey.ts"]) {
    const contents = source(file);
    assert.match(
      contents,
      /authorizeBrowserRequest\(/,
      `${file} must derive identity from the SWA principal`,
    );
    for (const smuggled of [
      /query\.get\(\s*["']email["']\s*\)/,
      /query\.get\(\s*["']user["']\s*\)/,
      /query\.get\(\s*["']userKey["']\s*\)/,
      /body\.email\b/,
    ]) {
      assert.ok(
        !smuggled.test(contents),
        `${file} must not read an identity from the request`,
      );
    }
  }
});

test("sender endpoints derive identity only by resolving the API key", () => {
  for (const file of ["notify.ts", "mcp.ts", "whoami.ts"]) {
    const contents = source(file);
    assert.match(contents, /resolveApiKeyOwner\(/, file);
    assert.ok(
      !/AUTHORIZED_USERS/.test(contents),
      `${file} must rely on key resolution for the allowlist check`,
    );
  }
});
