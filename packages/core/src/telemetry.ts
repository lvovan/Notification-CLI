/**
 * The telemetry vocabulary shared by the server and the browser.
 *
 * Microsoft Clarity is a browser product: it has no server-side ingestion, and
 * its Data Export API is read-only. A notification, however, is almost always
 * produced by something that has no browser at all — the CLI or an MCP client —
 * so the two halves are joined here instead. The server attributes every
 * notification to its source; the browser replays that attribution into Clarity
 * as tags and events when the notification arrives. Both sides import the names
 * below, so a rename cannot silently split the two datasets.
 *
 * This module is imported by the web bundle and must therefore stay free of
 * anything Node-specific. The server half lives in `telemetry-log.ts`.
 */

/** Where a notification was produced. */
export const NOTIFICATION_SOURCES = ["cli", "mcp", "web"] as const;

export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

export const DEFAULT_NOTIFICATION_SOURCE: NotificationSource = "cli";

/**
 * Declared by the caller of `/api/notify`, which the CLI and the web app's own
 * test button both use. It is telemetry, not a claim of authority: the API key
 * decides what a caller may do, and this only says which client it was.
 */
export const NOTIFICATION_SOURCE_HEADER = "x-notification-source";

export function parseNotificationSource(
  value: string | null | undefined,
  fallback: NotificationSource = DEFAULT_NOTIFICATION_SOURCE,
): NotificationSource {
  const candidate = value?.trim().toLowerCase();
  return NOTIFICATION_SOURCES.find((source) => source === candidate) ?? fallback;
}

/**
 * Session dimensions. Clarity segments recordings, heatmaps and funnels by
 * these, so each one answers "which kind of session is this?" rather than
 * "what happened?".
 */
export const CLARITY_TAGS = {
  /** browser | installed — is the PWA actually used as an installed app? */
  appMode: "app_mode",
  /** granted | denied | default | unsupported */
  pushPermission: "push_permission",
  /** true | false — permission granted is not the same as subscribed. */
  pushSubscribed: "push_subscribed",
  /** Bucketed lifetime volume: newcomer versus daily driver. */
  notificationVolume: "notification_volume",
  /** Bucketed last-24-hour volume: is this account active right now? */
  activity24h: "activity_24h",
  /** connected | connecting | disconnected | offline */
  connection: "connection",
  /** ios | android | macos | windows | other */
  platform: "platform",
  /** available | unavailable | installed */
  installPrompt: "install_prompt",
  /** dark | light */
  theme: "theme",
  /** How the most recent notification of the session was produced. */
  lastNotificationSource: "last_notification_source",
} as const;

/**
 * Actions. Clarity turns these into Smart Events, so each one is a thing a
 * person or the backend did, phrased so a funnel can be built from it.
 */
export const CLARITY_EVENTS = {
  notificationReceived: "notification_received",
  testNotificationSent: "test_notification_sent",
  pushEnabled: "push_enabled",
  pushDisabled: "push_disabled",
  pushFailed: "push_failed",
  pushHelpOpened: "push_help_opened",
  apiKeyCopied: "api_key_copied",
  apiKeyCycled: "api_key_cycled",
  historyPageLoaded: "history_page_loaded",
  historyCleared: "history_cleared",
  installPrompted: "install_prompted",
  installAccepted: "install_accepted",
  installDismissed: "install_dismissed",
  appUpdated: "app_updated",
  sessionExpired: "session_expired",
  connectionLost: "connection_lost",
} as const;

/** Per-source arrival events, so a funnel can separate MCP from CLI traffic. */
export function notificationSourceEvent(source: NotificationSource): string {
  return `notification_source_${source}`;
}

/**
 * Exact counts make poor session dimensions: they fragment a segment into as
 * many values as there are users. Buckets keep the tag answering "what kind of
 * user is this?".
 */
export function bucket(value: number, boundaries: readonly number[]): string {
  let lower = 0;
  for (const boundary of boundaries) {
    if (value < boundary) {
      return lower === boundary - 1 ? String(lower) : `${lower}-${boundary - 1}`;
    }
    lower = boundary;
  }
  return `${lower}+`;
}

/** Lifetime notification volume boundaries for `CLARITY_TAGS.notificationVolume`. */
export const VOLUME_BUCKETS = [1, 10, 50, 200] as const;

/** Last-24-hour boundaries for `CLARITY_TAGS.activity24h`. */
export const ACTIVITY_BUCKETS = [1, 5, 20] as const;

/** ios | android | macos | windows | other, from the coarsest signal available. */
export function platformName(userAgent: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod/i.test(userAgent)) {
    return "ios";
  }
  // iPadOS reports a desktop Safari user agent, and is only distinguishable
  // from a Mac by the presence of a touch screen.
  if (
    /iPad/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)
  ) {
    return "ios";
  }
  if (/Android/i.test(userAgent)) {
    return "android";
  }
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return "macos";
  }
  if (/Windows/i.test(userAgent)) {
    return "windows";
  }
  return "other";
}
