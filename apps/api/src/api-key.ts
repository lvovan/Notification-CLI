import { timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";

export const MCP_API_KEY_ENV = "NOTIFICATION_CLI_MCP_API_KEY";
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
  environmentVariable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredKey = env[environmentVariable];
  if (!configuredKey) {
    throw new Error(`${environmentVariable} is not configured.`);
  }

  const authorization = request.headers.get("authorization");
  const bearerKey = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  return (
    secureEqual(bearerKey, configuredKey) ||
    secureEqual(request.headers.get("x-api-key"), configuredKey)
  );
}
