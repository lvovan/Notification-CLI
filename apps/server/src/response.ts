import type { ServerResponse } from "node:http";
import type { CoreResponse } from "@notification-cli/core/http";

/**
 * Applied to every response, mirroring the `globalHeaders` the Static Web App
 * serves so the two hosts present the same security posture.
 */
export const GLOBAL_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data:; style-src 'self'; script-src 'self' 'sha256-HNjOU2rt1GsFc5zDEQXklLEbjDyKexAo5wKONo5tkTc='; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function send(response: ServerResponse, result: CoreResponse): void {
  const headers: Record<string, string | string[]> = {
    ...GLOBAL_HEADERS,
    ...result.headers,
  };
  let body = result.body;
  if (result.jsonBody !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(result.jsonBody);
  }
  const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
  if (payload) {
    headers["Content-Length"] = String(payload.byteLength);
  }
  response.writeHead(result.status ?? 200, headers);
  response.end(payload);
}

export function sendBuffer(
  response: ServerResponse,
  status: number,
  payload: Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  response.writeHead(status, {
    ...GLOBAL_HEADERS,
    ...headers,
    "Content-Length": String(payload.byteLength),
  });
  response.end(payload);
}
