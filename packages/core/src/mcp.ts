import type { CoreRequest, CoreResponse, CoreLogger } from "./http.js";
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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
}

const tool = {
  name: "send_notification",
  description:
    "Send a real-time notification asking the user to return or perform an action.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The concise notification message to send.",
        minLength: 1,
        maxLength: 1000,
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
} as const;

function jsonRpcResult(
  id: JsonRpcRequest["id"],
  result: unknown,
): CoreResponse {
  return {
    status: 200,
    jsonBody: { jsonrpc: "2.0", id: id ?? null, result },
  };
}

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  status = 200,
): CoreResponse {
  return {
    status,
    jsonBody: {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    },
  };
}

export async function handleMcpRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  fanOut: (
    message: string,
    owner: NotificationOwner,
  ) => Promise<FanoutReport> = fanOutNotification,
  context?: CoreLogger,
  keys?: ApiKeyStore | null,
): Promise<CoreResponse> {
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
        jsonBody: { error: error.message },
      };
    }
    throw error;
  }

  let rpcRequest: JsonRpcRequest;
  try {
    rpcRequest = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error", 400);
  }

  if (
    rpcRequest.jsonrpc !== "2.0" ||
    typeof rpcRequest.method !== "string"
  ) {
    return jsonRpcError(rpcRequest.id, -32600, "Invalid Request", 400);
  }

  switch (rpcRequest.method) {
    case "initialize":
      return jsonRpcResult(rpcRequest.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "notification-cli", version: "1.0.0" },
      });
    case "notifications/initialized":
      return { status: 202 };
    case "ping":
      return jsonRpcResult(rpcRequest.id, {});
    case "tools/list":
      return jsonRpcResult(rpcRequest.id, { tools: [tool] });
    case "tools/call": {
      const params = rpcRequest.params as ToolCallParams | undefined;
      const args = params?.arguments as { message?: unknown } | undefined;
      const message = validateNotificationMessage(args?.message);
      if (params?.name !== tool.name || !message) {
        return jsonRpcError(
          rpcRequest.id,
          -32602,
          "Expected send_notification with a message of 1-1000 characters.",
        );
      }

      try {
        await fanOut(message, owner);
      } catch (error) {
        if (error instanceof FanoutError) {
          context?.error(
            `Notification delivery was incomplete: ${error.report.errors.join("; ")}`,
          );
          return jsonRpcResult(rpcRequest.id, {
            isError: true,
            content: [
              {
                type: "text",
                text: `Notification delivery was incomplete: ${error.report.errors.join("; ")}`,
              },
            ],
          });
        }
        if (error instanceof ConfigurationError) {
          context?.error(`Notification API misconfigured: ${error.message}`);
          return jsonRpcResult(rpcRequest.id, {
            isError: true,
            content: [
              {
                type: "text",
                text: `Notification service is misconfigured: ${error.message}`,
              },
            ],
          });
        }
        throw error;
      }
      return jsonRpcResult(rpcRequest.id, {
        content: [{ type: "text", text: "Notification sent." }],
      });
    }
    default:
      return jsonRpcError(rpcRequest.id, -32601, "Method not found");
  }
}
