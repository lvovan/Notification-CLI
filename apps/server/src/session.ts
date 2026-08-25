import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The identity port. The App Service host signs users in itself, but the
 * handlers only ever see the client principal shape Static Web Apps injects,
 * so both hosts share one authorization implementation.
 */
export interface SessionProvider {
  /** The signed-in address a request carries, or null when it carries none. */
  resolve(message: IncomingMessage): Promise<string | null> | string | null;
  /**
   * Serves a `/.auth/*` endpoint. Returns false when the path is not one this
   * provider owns, so the router can fall through to a 404.
   */
  handle(
    message: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> | boolean;
}

/** Encodes an address exactly as Static Web Apps encodes a signed-in user. */
export function clientPrincipal(email: string): string {
  return Buffer.from(
    JSON.stringify({
      identityProvider: "aad",
      userId: email,
      userDetails: email,
      userRoles: ["anonymous", "authenticated"],
    }),
  ).toString("base64");
}
