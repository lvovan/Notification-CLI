import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_BUCKETS,
  bucket,
  DEFAULT_NOTIFICATION_SOURCE,
  NOTIFICATION_SOURCE_HEADER,
  notificationSourceEvent,
  parseNotificationSource,
  platformName,
  VOLUME_BUCKETS,
} from "@notification-cli/core/telemetry";
import {
  clarityProjectId,
  CLARITY_PROJECT_ID_ENV,
  formatTelemetry,
  emitTelemetry,
  TELEMETRY_LOG_PREFIX,
} from "@notification-cli/core/telemetry-log";
import { fanOutNotification } from "@notification-cli/core/fanout";
import { notificationOwner } from "@notification-cli/core/identity";
import type { StoredNotification } from "@notification-cli/core/notification-storage";

const OWNER = "user@example.com";

test("a notification source is only accepted from the known vocabulary", () => {
  assert.equal(parseNotificationSource("cli"), "cli");
  assert.equal(parseNotificationSource("mcp"), "mcp");
  assert.equal(parseNotificationSource("web"), "web");
  // Casing and padding survive a hand-written header.
  assert.equal(parseNotificationSource(" MCP "), "mcp");
  // Anything unrecognised is attributed to the default rather than trusted.
  assert.equal(parseNotificationSource("curl"), DEFAULT_NOTIFICATION_SOURCE);
  assert.equal(parseNotificationSource(""), DEFAULT_NOTIFICATION_SOURCE);
  assert.equal(parseNotificationSource(null), DEFAULT_NOTIFICATION_SOURCE);
  assert.equal(parseNotificationSource(undefined), DEFAULT_NOTIFICATION_SOURCE);
});

test("the source header travels under a fixed lowercase name", () => {
  assert.equal(NOTIFICATION_SOURCE_HEADER, "x-notification-source");
  assert.equal(
    NOTIFICATION_SOURCE_HEADER,
    NOTIFICATION_SOURCE_HEADER.toLowerCase(),
  );
});

test("each source projects to its own analytics event", () => {
  assert.equal(notificationSourceEvent("cli"), "notification_source_cli");
  assert.equal(notificationSourceEvent("mcp"), "notification_source_mcp");
  assert.notEqual(
    notificationSourceEvent("web"),
    notificationSourceEvent("cli"),
  );
});

test("counts become bucketed session dimensions rather than unique values", () => {
  assert.equal(bucket(0, VOLUME_BUCKETS), "0");
  assert.equal(bucket(1, VOLUME_BUCKETS), "1-9");
  assert.equal(bucket(9, VOLUME_BUCKETS), "1-9");
  assert.equal(bucket(10, VOLUME_BUCKETS), "10-49");
  assert.equal(bucket(30, VOLUME_BUCKETS), "10-49");
  assert.equal(bucket(100, VOLUME_BUCKETS), "50-199");
  assert.equal(bucket(200, VOLUME_BUCKETS), "200+");
  assert.equal(bucket(5000, VOLUME_BUCKETS), "200+");

  // A leading boundary of 1 must read as a bare "0", not "0-0".
  assert.equal(bucket(0, ACTIVITY_BUCKETS), "0");
  assert.equal(bucket(4, ACTIVITY_BUCKETS), "1-4");
  assert.equal(bucket(5, ACTIVITY_BUCKETS), "5-19");
  assert.equal(bucket(20, ACTIVITY_BUCKETS), "20+");
});

test("the platform dimension separates iPadOS from macOS by touch", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";

  assert.equal(platformName(iphone), "ios");
  // iPadOS claims to be a Mac; only the touch screen gives it away.
  assert.equal(platformName(ipad, 5), "ios");
  assert.equal(platformName(mac, 0), "macos");
  assert.equal(platformName("Mozilla/5.0 (Linux; Android 14)"), "android");
  assert.equal(platformName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(platformName("Mozilla/5.0 (X11; Linux x86_64)"), "other");
});

test("an analytics project id is read only when it is well formed", () => {
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "abcd1234" }), "abcd1234");
  // Portal ids are shown uppercase often enough to be pasted that way.
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: " ABCD1234 " }), "abcd1234");
  assert.equal(clarityProjectId({}), null);
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "" }), null);
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "abc" }), null);
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "a".repeat(33) }), null);
  // A malformed value must never reach a script URL or a CSP header.
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "abcd/../evil" }), null);
  assert.equal(clarityProjectId({ [CLARITY_PROJECT_ID_ENV]: "abcd 1234" }), null);
});

test("telemetry lines are single-line json without empty fields", () => {
  const line = formatTelemetry({
    event: "notify.delivered",
    source: "cli",
    durationMs: 12,
    metricError: undefined,
  });

  assert.ok(line.startsWith(`${TELEMETRY_LOG_PREFIX} `));
  const payload: unknown = JSON.parse(line.slice(TELEMETRY_LOG_PREFIX.length + 1));
  assert.deepEqual(payload, {
    event: "notify.delivered",
    source: "cli",
    durationMs: 12,
  });
  assert.equal(line.includes("\n"), false);
});

test("telemetry never carries message text or an address", () => {
  const messages: string[] = [];
  emitTelemetry(
    { error: () => undefined, info: (message: string) => messages.push(message) },
    {
      event: "notify.delivered",
      source: "cli",
      messageLength: "the secret plan".length,
    },
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.includes("the secret plan"), false);
  assert.equal(messages[0]?.includes(OWNER), false);
  assert.match(messages[0] ?? "", /"messageLength":15/);
});

test("a logger without an info channel is tolerated", () => {
  assert.doesNotThrow(() => {
    emitTelemetry(undefined, { event: "notify.delivered" });
    emitTelemetry({ error: () => undefined }, { event: "notify.delivered" });
  });
});

test("the source reaches live delivery but is never retained in history", async () => {
  const delivered: object[] = [];
  const appended: StoredNotification[] = [];

  const report = await fanOutNotification("hello", notificationOwner(OWNER), {
    env: {},
    source: "mcp",
    notificationId: () => "notification-id",
    webPubSub: {
      group: () => ({
        sendToAll: async (message) => {
          delivered.push(message as object);
        },
      }),
    },
    history: {
      append: async (_key: string, notification: StoredNotification) => {
        appended.push(notification);
      },
      prune: async () => 0,
      list: async () => ({ notifications: [], nextCursor: null }),
      clear: async () => 0,
    },
  });

  assert.equal(report.source, "mcp");
  assert.equal((delivered[0] as { source?: string }).source, "mcp");
  assert.equal(appended.length, 1);
  // Replaying history must not manufacture fresh arrival events.
  assert.equal("source" in (appended[0] as object), false);
});
