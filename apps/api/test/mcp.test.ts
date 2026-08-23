import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import { FanoutError, type FanoutReport } from "../src/fanout.js";
import { handleMcpRequest, isAuthorized } from "../src/mcp.js";

function requestWithHeaders(values: Record<string, string>) {
  return { headers: new Headers(values) } as Pick<HttpRequest, "headers">;
}

test("accepts only the MCP x-api-key", () => {
  const env = {
    NOTIFICATION_CLI_MCP_API_KEY: "mcp-test-key",
    NOTIFICATION_CLI_API_KEY: "cli-test-key",
  };
  assert.equal(
    isAuthorized(requestWithHeaders({ "x-api-key": "mcp-test-key" }), env),
    true,
  );
  assert.equal(
    isAuthorized(requestWithHeaders({ "x-api-key": "cli-test-key" }), env),
    false,
  );
});

test("rejects Authorization header authentication", () => {
  const env = { NOTIFICATION_CLI_MCP_API_KEY: "test-key" };
  assert.equal(
    isAuthorized(requestWithHeaders({ authorization: "Bearer test-key" }), env),
    false,
  );
});

function toolCallRequest(message: string): HttpRequest {
  return {
    headers: new Headers({ "x-api-key": "mcp-test-key" }),
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_notification",
        arguments: { message },
      },
    }),
  } as unknown as HttpRequest;
}

test("send_notification uses shared fan-out and reports partial delivery", async () => {
  let delivered = "";
  const successfulReport: FanoutReport = {
    webPubSubDelivered: true,
    pushAttempted: 1,
    pushDelivered: 1,
    pushRemoved: 0,
    pushFailed: 0,
    errors: [],
  };
  const accepted = await handleMcpRequest(
    toolCallRequest(" hello "),
    { NOTIFICATION_CLI_MCP_API_KEY: "mcp-test-key" },
    async (message) => {
      delivered = message;
      return successfulReport;
    },
  );
  assert.equal(delivered, "hello");
  assert.equal(
    (
      accepted.jsonBody as {
        result: { content: Array<{ text: string }> };
      }
    ).result.content[0]?.text,
    "Notification sent.",
  );

  const failedReport: FanoutReport = {
    ...successfulReport,
    pushDelivered: 0,
    pushFailed: 1,
    errors: ["Web Push delivery failed"],
  };
  const partial = await handleMcpRequest(
    toolCallRequest("hello"),
    { NOTIFICATION_CLI_MCP_API_KEY: "mcp-test-key" },
    async () => {
      throw new FanoutError(failedReport);
    },
  );
  const result = (
    partial.jsonBody as {
      result: { isError: boolean; content: Array<{ text: string }> };
    }
  ).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /incomplete/);
});
