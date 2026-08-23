import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import {
  hasValidApiKey,
  NOTIFICATION_API_KEY_ENV,
} from "./api-key.js";
import {
  FanoutError,
  fanOutNotification,
  validateNotificationMessage,
  type FanoutReport,
} from "./fanout.js";

export async function handleNotifyRequest(
  request: HttpRequest,
  env: NodeJS.ProcessEnv = process.env,
  fanOut: (message: string) => Promise<FanoutReport> = fanOutNotification,
): Promise<HttpResponseInit> {
  if (!hasValidApiKey(request, NOTIFICATION_API_KEY_ENV, env)) {
    return {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
      jsonBody: { error: "Unauthorized" },
    };
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
    const delivery = await fanOut(message);
    return { status: 200, jsonBody: { delivered: true, delivery } };
  } catch (error) {
    if (error instanceof FanoutError) {
      return {
        status: 502,
        jsonBody: {
          delivered: false,
          error: error.message,
          delivery: error.report,
        },
      };
    }
    throw error;
  }
}
