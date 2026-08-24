import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { resolveApiKeyOwner } from "./api-key.js";
import type { ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import {
  FanoutError,
  fanOutNotification,
  validateNotificationMessage,
  type FanoutReport,
} from "./fanout.js";
import type { NotificationOwner } from "./identity.js";

export async function handleNotifyRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  fanOut: (
    message: string,
    owner: NotificationOwner,
  ) => Promise<FanoutReport> = fanOutNotification,
  context?: InvocationContext,
  keys?: ApiKeyStore | null,
): Promise<HttpResponseInit> {
  let owner: NotificationOwner;
  try {
    const resolution = await resolveApiKeyOwner(request, env, keys);
    if (!resolution.authorized) {
      return {
        status: 401,
        jsonBody: { error: "Unauthorized" },
      };
    }
    owner = resolution.owner;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      context?.error(`Notification API misconfigured: ${error.message}`);
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
    return { status: 400, jsonBody: { error: "Invalid JSON body." } };
  }
  const message = validateNotificationMessage(
    typeof value === "object" && value !== null && "message" in value
      ? value.message
      : undefined,
  );
  if (!message) {
    return {
      status: 400,
      jsonBody: {
        error: "message must contain between 1 and 1000 characters.",
      },
    };
  }

  try {
    const delivery = await fanOut(message, owner);
    return { status: 200, jsonBody: { delivered: true, delivery } };
  } catch (error) {
    if (error instanceof FanoutError) {
      context?.error(
        `Notification delivery was incomplete: ${error.report.errors.join("; ")}`,
      );
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
      return {
        status: 503,
        jsonBody: { delivered: false, error: error.message },
      };
    }
    throw error;
  }
}
