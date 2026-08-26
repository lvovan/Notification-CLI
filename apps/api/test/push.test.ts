import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import type { ApiKeyStore } from "@notification-cli/core/api-key-storage";
import { ConfigurationError } from "@notification-cli/core/configuration";
import {
  FanoutError,
  fanOutNotification,
  validateNotificationMessage,
  type WebPushSender,
} from "@notification-cli/core/fanout";
import { notificationOwner } from "@notification-cli/core/identity";
import { handleNotifyRequest } from "@notification-cli/core/notify";
import {
  handleDeletePushSubscription,
  handlePushConfigRequest,
  handleSavePushSubscription,
} from "@notification-cli/core/push";
import {
  parsePushSubscription,
  type PushSubscriptionData,
  type PushSubscriptionStore,
  type StoredPushSubscription,
} from "@notification-cli/core/push-storage";

const OWNER = "user@example.com";
const CLI_KEY = "ncli_cli-test-key";
const authorizedEnv = {
  NOTIFICATION_CLI_VAPID_PUBLIC_KEY: `B${"A".repeat(86)}`,
};

const SENT_AT = new Date("2026-03-15T12:00:00.000Z");

function principalHeader(email = " User@Example.com "): string {
  return Buffer.from(
    JSON.stringify({
      identityProvider: "aad",
      userId: "user-id",
      userDetails: email,
      userRoles: ["authenticated"],
    }),
  ).toString("base64");
}

function request(
  body?: unknown,
  headers: Record<string, string> = {
    "x-ms-client-principal": principalHeader(),
  },
): HttpRequest {
  return {
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as HttpRequest;
}

class MemoryStore implements PushSubscriptionStore {
  saved: Array<{ identity: string; subscription: PushSubscriptionData }> = [];
  removed: Array<{ identity: string; endpoint: string }> = [];
  removedStored: StoredPushSubscription[] = [];
  listedIdentities: string[] = [];

  constructor(public subscriptions: StoredPushSubscription[] = []) {}

  async save(
    identity: string,
    subscription: PushSubscriptionData,
  ): Promise<void> {
    this.saved.push({ identity, subscription });
  }

  async remove(identity: string, endpoint: string): Promise<void> {
    this.removed.push({ identity, endpoint });
  }

  async removeStored(subscription: StoredPushSubscription): Promise<void> {
    this.removedStored.push(subscription);
  }

  async list(identity: string): Promise<StoredPushSubscription[]> {
    this.listedIdentities.push(identity);
    return this.subscriptions;
  }
}

/** Minimal stand-in; the lifecycle itself is covered in api-key.test.ts. */
const keyStore: ApiKeyStore = {
  ensure: async (email) => ({ email, apiKey: CLI_KEY, createdAt: 0 }),
  cycle: async (email) => ({ email, apiKey: CLI_KEY, createdAt: 0 }),
  resolve: async (apiKey) => (apiKey === CLI_KEY ? OWNER : null),
};

const subscription = {
  endpoint: "https://push.example.test/subscription/1",
  expirationTime: null,
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

const storedSubscription: StoredPushSubscription = {
  partitionKey: "identity-hash",
  rowKey: "endpoint-hash",
  endpoint: subscription.endpoint,
  p256dh: subscription.keys.p256dh,
  auth: subscription.keys.auth,
};

test("validates messages and PushSubscription payloads", () => {
  assert.equal(validateNotificationMessage(" hello "), "hello");
  assert.equal(validateNotificationMessage(" "), null);
  assert.equal(validateNotificationMessage("x".repeat(1001)), null);
  assert.deepEqual(parsePushSubscription(subscription), subscription);
  assert.equal(
    parsePushSubscription({ ...subscription, endpoint: "http://insecure.test" }),
    null,
  );
});

test("push config requires authorization and returns the server public key", () => {
  const accepted = handlePushConfigRequest(request(), authorizedEnv);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.jsonBody, {
    publicKey: authorizedEnv.NOTIFICATION_CLI_VAPID_PUBLIC_KEY,
  });

  const denied = handlePushConfigRequest(
    request(undefined, {}),
    authorizedEnv,
  );
  assert.equal(denied.status, 401);

  const missingKey = handlePushConfigRequest(request(), {});
  assert.equal(missingKey.status, 503);
});

test("saves and removes subscriptions under the normalized identity", async () => {
  const store = new MemoryStore();
  const saved = await handleSavePushSubscription(
    request(subscription),
    authorizedEnv,
    store,
  );
  assert.equal(saved.status, 204);
  assert.equal(store.saved[0]?.identity, "user@example.com");
  assert.deepEqual(store.saved[0]?.subscription, subscription);

  const removed = await handleDeletePushSubscription(
    request({ endpoint: subscription.endpoint }),
    authorizedEnv,
    store,
  );
  assert.equal(removed.status, 204);
  assert.deepEqual(store.removed, [
    { identity: "user@example.com", endpoint: subscription.endpoint },
  ]);
});

test("rejects invalid subscription requests before storage", async () => {
  const store = new MemoryStore();
  const invalid = await handleSavePushSubscription(
    request({ endpoint: "invalid" }),
    authorizedEnv,
    store,
  );
  assert.equal(invalid.status, 400);
  assert.equal(store.saved.length, 0);

  const unauthorized = await handleSavePushSubscription(
    request(subscription, {}),
    authorizedEnv,
    store,
  );
  assert.equal(unauthorized.status, 401);
});

test("fan-out delivers through Web PubSub and Web Push", async () => {
  const store = new MemoryStore([storedSubscription]);
  const pubSubMessages: object[] = [];
  const pushPayloads: string[] = [];
  const report = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: authorizedEnv,
    notificationId: () => "notification-id",
    now: () => SENT_AT,
    webPubSub: {
      group: () => ({
        sendToAll: async (message) => {
          pubSubMessages.push(message);
        },
      }),
    },
    store,
    webPush: {
      send: async (_subscription, payload) => {
        pushPayloads.push(payload);
      },
    },
  });

  assert.deepEqual(store.listedIdentities, [OWNER]);
  const notification = {
    id: "notification-id",
    title: "Notification CLI",
    body: "hello",
    sentAt: SENT_AT.getTime(),
  };
  // The Web PubSub SDK serializes JSON payloads itself; sending a string here
  // would double-encode the notification and reach browsers as quoted JSON.
  assert.deepEqual(pubSubMessages, [notification]);
  assert.deepEqual(pushPayloads, [JSON.stringify(notification)]);
  assert.deepEqual(report, {
    webPubSubDelivered: true,
    pushConfigured: true,
    pushAttempted: 1,
    pushDelivered: 1,
    pushRemoved: 0,
    pushFailed: 0,
    errors: [],
  });
});

test("fan-out succeeds through Web PubSub alone when push is not configured", async () => {
  const pubSubMessages: object[] = [];
  const report = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    notificationId: () => "notification-id",
    webPubSub: {
      group: () => ({
        sendToAll: async (message) => {
          pubSubMessages.push(message);
        },
      }),
    },
  });

  assert.equal(pubSubMessages.length, 1);
  assert.deepEqual(report, {
    webPubSubDelivered: true,
    pushConfigured: false,
    pushAttempted: 0,
    pushDelivered: 0,
    pushRemoved: 0,
    pushFailed: 0,
    errors: [],
  });
});

test("fan-out removes expired subscriptions and surfaces other failures", async () => {
  const store = new MemoryStore([
    storedSubscription,
    { ...storedSubscription, rowKey: "second", endpoint: "https://push.example.test/2" },
  ]);
  const sender: WebPushSender = {
    send: async (pushSubscription) => {
      if (pushSubscription.endpoint === subscription.endpoint) {
        throw Object.assign(new Error("expired"), { statusCode: 410 });
      }
      throw Object.assign(new Error("provider unavailable"), {
        statusCode: 503,
      });
    },
  };

  await assert.rejects(
    fanOutNotification("hello", notificationOwner(OWNER), {
      env: authorizedEnv,
      notificationId: () => "notification-id",
      webPubSub: { group: () => ({ sendToAll: async () => undefined }) },
      store,
      webPush: sender,
    }),
    (error: unknown) => {
      assert.ok(error instanceof FanoutError);
      assert.equal(error.report.webPubSubDelivered, true);
      assert.equal(error.report.pushRemoved, 1);
      assert.equal(error.report.pushFailed, 1);
      assert.match(error.report.errors[0] ?? "", /provider unavailable/);
      return true;
    },
  );
  assert.deepEqual(store.removedStored, [storedSubscription]);
});

test("notify uses API-key auth, validates JSON, and reports partial failure", async () => {
  let deliveredMessage = "";
  const accepted = await handleNotifyRequest(
    request({ message: " hello " }, { "x-api-key": CLI_KEY }),
    authorizedEnv,
    async (message) => {
      deliveredMessage = message;
      return {
        webPubSubDelivered: true,
        pushConfigured: false,
        pushAttempted: 0,
        pushDelivered: 0,
        pushRemoved: 0,
        pushFailed: 0,
        errors: [],
      };
    },
    undefined,
    keyStore,
  );
  assert.equal(accepted.status, 200);
  assert.equal(deliveredMessage, "hello");

  const denied = await handleNotifyRequest(
    request({ message: "hello" }, { "x-api-key": "ncli_wrong-key" }),
    authorizedEnv,
    undefined,
    undefined,
    keyStore,
  );
  assert.equal(denied.status, 401);

  const invalid = await handleNotifyRequest(
    request({ message: "" }, { "x-api-key": CLI_KEY }),
    authorizedEnv,
    undefined,
    undefined,
    keyStore,
  );
  assert.equal(invalid.status, 400);

  const unconfigured = await handleNotifyRequest(
    request({ message: "hello" }, { "x-api-key": CLI_KEY }),
    authorizedEnv,
    undefined,
    undefined,
    null,
  );
  assert.equal(unconfigured.status, 503);

  const report = {
    webPubSubDelivered: true,
    pushConfigured: true,
    pushAttempted: 1,
    pushDelivered: 0,
    pushRemoved: 0,
    pushFailed: 1,
    errors: ["Web Push delivery failed"],
  };
  const partial = await handleNotifyRequest(
    request({ message: "hello" }, { "x-api-key": CLI_KEY }),
    authorizedEnv,
    async () => {
      throw new FanoutError(report);
    },
    undefined,
    keyStore,
  );
  assert.equal(partial.status, 502);
  assert.equal(
    (partial.jsonBody as { delivered: boolean }).delivered,
    false,
  );
});

test("notify reports 503 naming the missing setting when misconfigured", async () => {
  const response = await handleNotifyRequest(
    request({ message: "hello" }, { "x-api-key": CLI_KEY }),
    authorizedEnv,
    async () => {
      throw new ConfigurationError(
        "NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING",
      );
    },
    undefined,
    keyStore,
  );
  assert.equal(response.status, 503);
  assert.match(
    (response.jsonBody as { error: string }).error,
    /NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING is not configured/,
  );
});
