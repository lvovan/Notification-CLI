/**
 * Server-side telemetry, and the setting that turns browser analytics on.
 *
 * Separated from the shared vocabulary in `telemetry.ts` because this half
 * reads the environment and writes to a logger, neither of which exists in a
 * browser. The web bundle imports only the vocabulary.
 */

import type { CoreLogger } from "./http.js";

export const CLARITY_PROJECT_ID_ENV = "NOTIFICATION_CLI_CLARITY_PROJECT_ID";

/**
 * Clarity project ids are short lowercase alphanumeric tokens. Validating the
 * shape keeps a typo from being interpolated into a script URL, and keeps the
 * Content-Security-Policy from being widened for a value that could never have
 * loaded a tag anyway.
 */
const CLARITY_PROJECT_ID_PATTERN = /^[a-z0-9]{4,32}$/;

export function clarityProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env[CLARITY_PROJECT_ID_ENV]?.trim().toLowerCase();
  return value && CLARITY_PROJECT_ID_PATTERN.test(value) ? value : null;
}

/**
 * A structured server-side event.
 *
 * These are the half of the picture Clarity cannot see, because the caller has
 * no browser. They are written as single-line JSON so App Service log queries
 * can parse them without a log-shipping agent.
 */
export interface TelemetryEvent {
  readonly event: string;
  readonly [field: string]: string | number | boolean | undefined;
}

/** Prefix that makes the events greppable in an undifferentiated log stream. */
export const TELEMETRY_LOG_PREFIX = "notification-cli-telemetry";

/**
 * Never accepts a message body or an email address: everything here is either a
 * category, a count or an already-hashed key. Undefined fields are dropped so
 * an absent measurement is distinguishable from a zero.
 */
export function formatTelemetry(event: TelemetryEvent): string {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return `${TELEMETRY_LOG_PREFIX} ${JSON.stringify(fields)}`;
}

/**
 * Telemetry must never be able to fail a request that would otherwise have
 * succeeded, so a logger without `info` is simply a logger that does not
 * collect telemetry.
 */
export function emitTelemetry(
  logger: CoreLogger | undefined,
  event: TelemetryEvent,
): void {
  logger?.info?.(formatTelemetry(event));
}
