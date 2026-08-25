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

/**
 * Defers building a provider until a request needs one.
 *
 * Sign-in settings are read at that point rather than at startup, so a site
 * that is missing one still boots and can say which. Failing at startup would
 * leave App Service serving its own welcome page, which says nothing at all.
 */
export function lazySessionProvider(create: () => SessionProvider): SessionProvider {
  let provider: SessionProvider | undefined;
  const resolved = (): SessionProvider => (provider ??= create());

  return {
    resolve: (message) => resolved().resolve(message),
    handle: (message, response, pathname) => resolved().handle(message, response, pathname),
  };
}
