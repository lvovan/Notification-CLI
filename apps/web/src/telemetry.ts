/**
 * Microsoft Clarity, wired without weakening the page's Content-Security-Policy.
 *
 * The tag is injected as an external script rather than pasted as Clarity's
 * inline quick-start snippet, so `script-src` needs an origin but never
 * `unsafe-inline`. Every call below is a no-op until `startTelemetry` succeeds,
 * so a deployment with no project id configured simply collects nothing and
 * every call site stays unconditional.
 */

import {
  ACTIVITY_BUCKETS,
  bucket,
  CLARITY_EVENTS,
  CLARITY_TAGS,
  notificationSourceEvent,
  platformName,
  VOLUME_BUCKETS,
  type NotificationSource,
} from "@notification-cli/core/telemetry";

export {
  ACTIVITY_BUCKETS,
  bucket,
  CLARITY_EVENTS,
  CLARITY_TAGS,
  platformName,
  VOLUME_BUCKETS,
};

type ClarityFunction = ((...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    clarity?: ClarityFunction;
  }
}

const TAG_ORIGIN = "https://www.clarity.ms/tag/";

let started = false;

function clarity(...args: unknown[]): void {
  if (!started) {
    return;
  }
  try {
    window.clarity?.(...args);
  } catch {
    // Analytics must never break the page it is measuring.
  }
}

/**
 * Clarity's own snippet defines this queueing stub so calls made before the tag
 * finishes downloading are not lost. Recreating it here keeps that guarantee
 * while letting the tag itself load from a plain `src`.
 */
function installQueue(): void {
  if (window.clarity) {
    return;
  }
  const queued: ClarityFunction = (...args: unknown[]) => {
    (queued.q ??= []).push(args);
  };
  window.clarity = queued;
}

/**
 * A stable pseudonym rather than the address itself: Clarity is a third party,
 * and correlating a person's sessions across visits needs only that the value
 * be the same every time, not that it be readable.
 */
async function pseudonym(email: string): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(email.trim().toLowerCase()),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 32);
  } catch {
    return undefined;
  }
}

export interface TelemetryStartOptions {
  projectId: string | null | undefined;
  email?: string;
}

/** Returns whether telemetry was actually started. */
export function startTelemetry(options: TelemetryStartOptions): boolean {
  if (started || !options.projectId) {
    return started;
  }
  installQueue();
  const tag = document.createElement("script");
  tag.async = true;
  tag.src = `${TAG_ORIGIN}${encodeURIComponent(options.projectId)}`;
  document.head.append(tag);
  started = true;

  if (options.email) {
    void pseudonym(options.email).then((id) => {
      if (id) {
        clarity("identify", id);
      }
    });
  }
  return true;
}

export function tagSession(key: string, value: string): void {
  clarity("set", key, value);
}

export function trackEvent(name: string): void {
  clarity("event", name);
}

/**
 * Notifications almost always originate somewhere Clarity cannot see — the CLI
 * or an MCP client. The server names that origin on the live delivery, and this
 * is where that backend fact enters the analytics timeline.
 */
export function trackNotificationArrival(source?: NotificationSource): void {
  trackEvent(CLARITY_EVENTS.notificationReceived);
  if (source) {
    trackEvent(notificationSourceEvent(source));
    tagSession(CLARITY_TAGS.lastNotificationSource, source);
  }
}
