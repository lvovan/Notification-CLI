import type { IncomingMessage } from "node:http";
import type { CoreRequest } from "@notification-cli/core/http";

/** Headers a client may never set: the server is the only source of identity. */
const RESERVED = new Set(["x-ms-client-principal"]);

function headerValue(
  message: IncomingMessage,
  name: string,
  injected: Readonly<Record<string, string>>,
): string | null {
  const key = name.toLowerCase();
  const override = injected[key];
  if (override !== undefined) {
    return override;
  }
  if (RESERVED.has(key)) {
    return null;
  }
  const raw = message.headers[key];
  if (raw === undefined) {
    return null;
  }
  return Array.isArray(raw) ? raw.join(", ") : raw;
}

/**
 * The public origin of a request. App Service terminates TLS and forwards the
 * original scheme, so https is the right default when nothing says otherwise.
 */
export function requestOrigin(message: IncomingMessage): string {
  const forwarded = message.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0];
  return `${protocol ?? "https"}://${message.headers.host ?? "localhost"}`;
}

async function readBody(message: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Presents a Node request as the host-neutral shape the handlers expect.
 *
 * Injected headers win over the wire, which is how a resolved session reaches
 * the handlers as the `x-ms-client-principal` they already understand; an
 * inbound header of that name is discarded rather than trusted.
 */
export function toCoreRequest(
  message: IncomingMessage,
  origin: string,
  injected: Readonly<Record<string, string>> = {},
): CoreRequest {
  const url = new URL(message.url ?? "/", origin);
  let body: Promise<string> | undefined;
  const text = (): Promise<string> => (body ??= readBody(message));

  return {
    method: message.method ?? "GET",
    url: url.toString(),
    headers: { get: (name) => headerValue(message, name, injected) },
    query: { get: (name) => url.searchParams.get(name) },
    text,
    json: async () => JSON.parse(await text()) as unknown,
  };
}
