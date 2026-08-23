import { randomUUID } from "node:crypto";
import webPush, { type PushSubscription } from "web-push";
import { AUTHORIZED_USERS_ENV, parseAuthorizedUsers } from "./auth.js";
import { hasSetting, requireSetting } from "./configuration.js";
import {
  tryCreatePushSubscriptionStore,
  type PushSubscriptionStore,
  type StoredPushSubscription,
} from "./push-storage.js";
import { createWebPubSubClient } from "./web-pubsub.js";

export const VAPID_PUBLIC_KEY_ENV = "NOTIFICATION_CLI_VAPID_PUBLIC_KEY";
export const VAPID_PRIVATE_KEY_ENV = "NOTIFICATION_CLI_VAPID_PRIVATE_KEY";
export const VAPID_SUBJECT_ENV = "NOTIFICATION_CLI_VAPID_SUBJECT";
export const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

interface WebPubSubSender {
  sendToAll(
    message: string,
    options: { contentType: string },
  ): Promise<unknown>;
}

export interface WebPushSender {
  send(
    subscription: PushSubscription,
    payload: string,
  ): Promise<unknown>;
}

export interface FanoutReport {
  webPubSubDelivered: boolean;
  pushConfigured: boolean;
  pushAttempted: number;
  pushDelivered: number;
  pushRemoved: number;
  pushFailed: number;
  errors: string[];
}

export class FanoutError extends Error {
  constructor(public readonly report: FanoutReport) {
    super("Notification delivery was incomplete.");
    this.name = "FanoutError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown delivery error";
}

function deliveryStatusCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

export function validateNotificationMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const message = value.trim();
  return message.length > 0 &&
    Array.from(message).length <= MAX_NOTIFICATION_MESSAGE_LENGTH
    ? message
    : null;
}

export function createWebPushSender(
  env: NodeJS.ProcessEnv = process.env,
): WebPushSender {
  const publicKey = requireSetting(env, VAPID_PUBLIC_KEY_ENV);
  const privateKey = requireSetting(env, VAPID_PRIVATE_KEY_ENV);
  const subject = requireSetting(env, VAPID_SUBJECT_ENV);
  webPush.setVapidDetails(subject, publicKey, privateKey);
  return {
    send: (subscription, payload) =>
      webPush.sendNotification(subscription, payload, { TTL: 60 }),
  };
}

/** Returns null when VAPID credentials are intentionally not configured. */
export function tryCreateWebPushSender(
  env: NodeJS.ProcessEnv = process.env,
): WebPushSender | null {
  return hasSetting(env, VAPID_PUBLIC_KEY_ENV) &&
    hasSetting(env, VAPID_PRIVATE_KEY_ENV) &&
    hasSetting(env, VAPID_SUBJECT_ENV)
    ? createWebPushSender(env)
    : null;
}

async function deliverWebPush(
  subscriptions: StoredPushSubscription[],
  store: PushSubscriptionStore,
  sender: WebPushSender,
  payload: string,
  report: FanoutReport,
): Promise<void> {
  report.pushAttempted = subscriptions.length;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await sender.send(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime ?? null,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
        );
        report.pushDelivered += 1;
      } catch (error) {
        const status = deliveryStatusCode(error);
        if (status === 404 || status === 410) {
          try {
            await store.removeStored(subscription);
            report.pushRemoved += 1;
          } catch (removeError) {
            report.pushFailed += 1;
            report.errors.push(
              `Failed to remove an expired push subscription: ${errorMessage(removeError)}`,
            );
          }
          return;
        }
        report.pushFailed += 1;
        report.errors.push(`Web Push delivery failed: ${errorMessage(error)}`);
      }
    }),
  );
}

export async function fanOutNotification(
  message: string,
  dependencies?: {
    webPubSub?: WebPubSubSender;
    store?: PushSubscriptionStore;
    webPush?: WebPushSender;
    env?: NodeJS.ProcessEnv;
    notificationId?: () => string;
  },
): Promise<FanoutReport> {
  const report: FanoutReport = {
    webPubSubDelivered: false,
    pushConfigured: false,
    pushAttempted: 0,
    pushDelivered: 0,
    pushRemoved: 0,
    pushFailed: 0,
    errors: [],
  };

  const env = dependencies?.env ?? process.env;
  // An empty allowlist yields no push targets, so background push fails closed
  // without blocking real-time delivery.
  const authorizedUsers = parseAuthorizedUsers(env[AUTHORIZED_USERS_ENV]);
  const webPubSub = dependencies?.webPubSub ?? createWebPubSubClient(env);
  const store = dependencies?.store ?? tryCreatePushSubscriptionStore(env);
  const sender = dependencies?.webPush ?? tryCreateWebPushSender(env);
  report.pushConfigured = Boolean(store && sender);

  const notification = JSON.stringify({
    id: (dependencies?.notificationId ?? randomUUID)(),
    title: "Notification CLI",
    body: message,
  });

  const results = await Promise.allSettled([
    webPubSub.sendToAll(notification, { contentType: "application/json" }),
    (async () => {
      if (!store || !sender || authorizedUsers.size === 0) {
        return;
      }
      const subscriptions = await store.list(authorizedUsers);
      await deliverWebPush(
        subscriptions,
        store,
        sender,
        notification,
        report,
      );
    })(),
  ]);

  if (results[0].status === "fulfilled") {
    report.webPubSubDelivered = true;
  } else {
    report.errors.push(
      `Web PubSub delivery failed: ${errorMessage(results[0].reason)}`,
    );
  }
  if (results[1].status === "rejected") {
    report.pushFailed += 1;
    report.errors.push(
      `Web Push delivery failed: ${errorMessage(results[1].reason)}`,
    );
  }

  if (report.errors.length > 0) {
    throw new FanoutError(report);
  }
  return report;
}
