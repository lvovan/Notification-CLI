import { timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";

/** Single shared key: the CLI and the MCP server present the same secret. */
export const NOTIFICATION_API_KEY_ENV = "NOTIFICATION_CLI_API_KEY";

function secureEqual(actual: string | null, expected: string): boolean {
  if (actual === null) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function hasValidApiKey(
  request: Pick<HttpRequest, "headers">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredKey = env[NOTIFICATION_API_KEY_ENV];
  if (!configuredKey) {
    throw new Error(`${NOTIFICATION_API_KEY_ENV} is not configured.`);
  }

  return secureEqual(request.headers.get("x-api-key"), configuredKey);
}
