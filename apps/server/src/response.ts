import type { ServerResponse } from "node:http";
import type { CoreResponse } from "@notification-cli/core/http";
import { clarityProjectId } from "@notification-cli/core/telemetry-log";

/** Hash of the one inline bootstrap script in index.html. */
const INLINE_BOOTSTRAP_HASH = "'sha256-HNjOU2rt1GsFc5zDEQXklLEbjDyKexAo5wKONo5tkTc='";

/**
 * Where Microsoft Clarity loads its tag from and uploads to. Clarity load
 * balances across lettered subdomains, so the wildcard is the documented form.
 */
const CLARITY_ORIGINS = "https://*.clarity.ms https://c.bing.com";

/**
 * The policy is built rather than fixed because the analytics origins are only
 * admitted when analytics is actually configured. A deployment that never sets
 * a Clarity project id keeps the tighter policy it had before, so the
 * third-party origins cannot be reached by anything else that lands on the
 * page.
 *
 * Clarity is added to `default-src` as Microsoft documents, which covers the
 * directives that fall back to it, and again to `script-src`, which does not
 * inherit once it is declared. The tag is loaded as an external script, so no
 * `unsafe-inline` is needed.
 */
export function globalHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const analytics = clarityProjectId(env) ? ` ${CLARITY_ORIGINS}` : "";
  return {
    "Content-Security-Policy": [
      `default-src 'self'${analytics}`,
      "connect-src 'self' https: wss:",
      `img-src 'self' data:${analytics}`,
      "style-src 'self'",
      `script-src 'self' ${INLINE_BOOTSTRAP_HASH}${analytics}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

/**
 * Applied to every response. Resolved once at startup: the application settings
 * cannot change without restarting the site.
 */
export const GLOBAL_HEADERS = globalHeaders();

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
