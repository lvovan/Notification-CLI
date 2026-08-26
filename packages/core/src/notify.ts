import type { CoreRequest, CoreResponse, CoreLogger } from "./http.js";
import { resolveApiKeyOwner } from "./api-key.js";
import type { ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import {
  emitDeliveryTelemetry,
  FanoutError,
  fanOutNotification,
  validateNotificationMessage,
  type FanoutReport,
} from "./fanout.js";
import type { NotificationOwner } from "./identity.js";
import {
  NOTIFICATION_SOURCE_HEADER,
  parseNotificationSource,
  type NotificationSource,
} from "./telemetry.js";
import { emitTelemetry } from "./telemetry-log.js";
export async function handleNotifyRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  fanOut: (
    message: string,
    owner: NotificationOwner,
    options: { source: NotificationSource },
  ) => Promise<FanoutReport> = fanOutNotification,
  context?: CoreLogger,
  keys?: ApiKeyStore | null,
): Promise<CoreResponse> {
  const source = parseNotificationSource(
    request.headers.get(NOTIFICATION_SOURCE_HEADER),
  );
  let owner: NotificationOwner;
  try {
    const resolution = await resolveApiKeyOwner(request, env, keys);
    if (!resolution.authorized) {
      emitTelemetry(context, {
        event: "notify.rejected",
        source,
        reason: "unauthorized",
      });
      return {
        status: 401,
        jsonBody: { error: "Unauthorized" },
      };
    }
    owner = resolution.owner;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      context?.error(`Notification API misconfigured: ${error.message}`);
      emitTelemetry(context, {
        event: "notify.rejected",
        source,
        reason: "misconfigured",
        setting: error.setting,
      });
      return {
        status: 503,
        jsonBody: { delivered: false, error: error.message },
      };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    emitTelemetry(context, {
      event: "notify.rejected",
      source,
      reason: "invalid-json",
    });
    return { status: 400, jsonBody: { error: "Invalid JSON body." } };
  }
  const message = validateNotificationMessage(
    typeof value === "object" && value !== null && "message" in value
      ? value.message
      : undefined,
  );
  if (!message) {
    emitTelemetry(context, {
      event: "notify.rejected",
      source,
      reason: "invalid-message",
    });
    return {
      status: 400,
      jsonBody: {
        error: "message must contain between 1 and 1000 characters.",
      },
    };
  }

  const startedAt = Date.now();
  try {
    const delivery = await fanOut(message, owner, { source });
    emitDeliveryTelemetry(context, "notify.delivered", source, delivery, {
      messageLength: message.length,
      durationMs: Date.now() - startedAt,
    });
    return { status: 200, jsonBody: { delivered: true, delivery } };
  } catch (error) {
    if (error instanceof FanoutError) {
      context?.error(
        `Notification delivery was incomplete: ${error.report.errors.join("; ")}`,
      );
      emitDeliveryTelemetry(context, "notify.failed", source, error.report, {
        messageLength: message.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        status: 502,
        jsonBody: {
          delivered: false,
          error: error.message,
          delivery: error.report,
        },
      };
    }
    if (error instanceof ConfigurationError) {
      context?.error(`Notification API misconfigured: ${error.message}`);
      emitTelemetry(context, {
        event: "notify.failed",
        source,
        reason: "misconfigured",
        setting: error.setting,
      });
      return {
        status: 503,
        jsonBody: { delivered: false, error: error.message },
      };
    }
    throw error;
  }
}
