import { randomUUID } from "node:crypto";
import webPush, { type PushSubscription } from "web-push";
import { hasSetting, requireSetting } from "./configuration.js";
import type { NotificationOwner } from "./identity.js";
import {
  DEFAULT_NOTIFICATION_SOURCE,
  type NotificationSource,
} from "./telemetry.js";
import { emitTelemetry } from "./telemetry-log.js";
import type { CoreLogger } from "./http.js";
import {
  tryCreateNotificationMetricsStore,
  type NotificationMetricsStore,
} from "./metrics-storage.js";
import {
  parseRetentionDays,
  RETENTION_DAYS_ENV,
  tryCreateNotificationHistoryStore,
  type NotificationHistoryStore,
  type StoredNotification,
} from "./notification-storage.js";
import {
  tryCreatePushSubscriptionStore,
  type PushSubscriptionStore,
  type StoredPushSubscription,
} from "./push-storage.js";
import {
  createNotificationSender,
  sendToUserGroup,
  type NotificationGroupSender,
} from "./web-pubsub.js";

export const VAPID_PUBLIC_KEY_ENV = "NOTIFICATION_CLI_VAPID_PUBLIC_KEY";
export const VAPID_PRIVATE_KEY_ENV = "NOTIFICATION_CLI_VAPID_PRIVATE_KEY";
export const VAPID_SUBJECT_ENV = "NOTIFICATION_CLI_VAPID_SUBJECT";
export const MAX_NOTIFICATION_MESSAGE_LENGTH = 1000;

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
  source?: NotificationSource;
  metricRecorded?: boolean;
  metricError?: string;
  historyRecorded?: boolean;
  historyPruned?: number;
  historyError?: string;
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

/**
 * Stores the notification under its owner so it can be read again later, then
 * lazily sweeps whatever has aged out of that owner's retention window.
 * Neither step may turn a delivered notification into a delivery failure.
 */
async function retainNotification(
  owner: NotificationOwner,
  notification: StoredNotification,
  sentAt: Date,
  env: NodeJS.ProcessEnv,
  report: FanoutReport,
  store = tryCreateNotificationHistoryStore(env),
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    const retentionDays = parseRetentionDays(env[RETENTION_DAYS_ENV]);
    await store.append(owner.userKey, notification);
    report.historyRecorded = true;
    report.historyPruned = await store.prune(
      owner.userKey,
      sentAt,
      retentionDays,
    );
  } catch (error) {
    report.historyError = errorMessage(error);
  }
}

/**
 * The delivery shape both `/api/notify` and `/api/mcp` report. Message text and
 * the owner's address are deliberately absent: the counts answer how well the
 * service is working, and neither of those would.
 */
export function emitDeliveryTelemetry(
  context: CoreLogger | undefined,
  event: string,
  source: NotificationSource,
  report: FanoutReport,
  extra: { messageLength: number; durationMs: number },
): void {
  emitTelemetry(context, {
    event,
    source,
    ...extra,
    webPubSubDelivered: report.webPubSubDelivered,
    pushConfigured: report.pushConfigured,
    pushAttempted: report.pushAttempted,
    pushDelivered: report.pushDelivered,
    pushRemoved: report.pushRemoved,
    pushFailed: report.pushFailed,
    metricRecorded: report.metricRecorded,
    historyRecorded: report.historyRecorded,
    historyPruned: report.historyPruned,
    errorCount: report.errors.length,
  });
}

export interface FanoutOptions {
  /** Where the notification was produced. Telemetry only. */
  source?: NotificationSource;
  webPubSub?: NotificationGroupSender;
  store?: PushSubscriptionStore;
  webPush?: WebPushSender;
  metrics?: NotificationMetricsStore;
  history?: NotificationHistoryStore;
  env?: NodeJS.ProcessEnv;
  notificationId?: () => string;
  now?: () => Date;
}

export async function fanOutNotification(
  message: string,
  owner: NotificationOwner,
  dependencies?: FanoutOptions,
): Promise<FanoutReport> {
  const source = dependencies?.source ?? DEFAULT_NOTIFICATION_SOURCE;
  const report: FanoutReport = {
    webPubSubDelivered: false,
    pushConfigured: false,
    pushAttempted: 0,
    pushDelivered: 0,
    pushRemoved: 0,
    pushFailed: 0,
    source,
    errors: [],
  };

  const env = dependencies?.env ?? process.env;
  const webPubSub = dependencies?.webPubSub ?? createNotificationSender(env);
  const store = dependencies?.store ?? tryCreatePushSubscriptionStore(env);
  const sender = dependencies?.webPush ?? tryCreateWebPushSender(env);
  report.pushConfigured = Boolean(store && sender);

  const sentAt = (dependencies?.now ?? (() => new Date()))();
  const notification = {
    id: (dependencies?.notificationId ?? randomUUID)(),
    title: "Notification CLI",
    body: message,
    sentAt: sentAt.getTime(),
  };
  /**
   * The source rides along with the live delivery only. It is telemetry about
   * how a notification was produced rather than part of the message, so it is
   * reported to a browser that is open at the time and deliberately not
   * retained: replaying history must not manufacture fresh arrival events.
   */
  const delivered = { ...notification, source };
  const pushPayload = JSON.stringify(delivered);

  const results = await Promise.allSettled([
    // Delivery is scoped to the owner's group. The SDK serializes JSON payloads
    // itself, so the object must be passed through unstringified to avoid
    // double-encoding it for browsers.
    sendToUserGroup(webPubSub, owner.email, delivered),
    (async () => {
      if (!store || !sender) {
        return;
      }
      const subscriptions = await store.list(owner.email);
      await deliverWebPush(
        subscriptions,
        store,
        sender,
        pushPayload,
        report,
      );
    })(),
  ]);

  if (results[0].status === "fulfilled") {
    report.webPubSubDelivered = true;
    const metrics =
      dependencies?.metrics ?? tryCreateNotificationMetricsStore(env);
    if (metrics) {
      try {
        await metrics.record(owner.userKey, sentAt);
        report.metricRecorded = true;
      } catch (error) {
        // Metrics are telemetry: a storage failure must never turn a delivered
        // notification into a reported delivery failure.
        report.metricError = errorMessage(error);
      }
    }
    await retainNotification(
      owner,
      notification,
      sentAt,
      env,
      report,
      dependencies?.history,
    );
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
