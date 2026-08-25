import type { CoreRequest, CoreHeaders } from "./http.js";
import { AUTHORIZED_USERS_ENV, parseAuthorizedUsers } from "./auth.js";
import { tryCreateApiKeyStore, type ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import { notificationOwner, type NotificationOwner } from "./identity.js";
import { STORAGE_CONNECTION_STRING_ENV } from "./table-storage.js";

export type ApiKeyResolution =
  | { authorized: true; owner: NotificationOwner }
  | { authorized: false };

const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

/**
 * Headers the key is accepted from, in the order they are consulted.
 *
 * `x-api-key` is what the CLI sends. `Authorization: Bearer <key>` is what
 * most MCP clients send by default, but Static Web Apps replaces that header
 * with its own platform token on the way to a managed function, so a token sent
 * that way never arrives. `x-authorization` carries the same
 * `Bearer <key>` value and is forwarded untouched, which makes it the one to
 * use behind Static Web Apps.
 */
const KEY_HEADERS = ["x-api-key", "x-authorization", "authorization"] as const;

/** Extracts the key from whichever accepted header carries it. */
export function presentedApiKey(
  headers: CoreHeaders,
): string | null {
  for (const name of KEY_HEADERS) {
    const value = headers.get(name)?.trim();
    if (!value) {
      continue;
    }
    // The dedicated header holds the bare key; the others use the scheme.
    const key =
      name === "x-api-key" ? value : BEARER_SCHEME.exec(value)?.[1]?.trim();
    if (key) {
      return key;
    }
  }
  return null;
}
/**
 * Resolves the presented key to the account that owns it. Authorization is
 * re-evaluated on every request, so removing an address from AUTHORIZED_USERS
 * revokes its key immediately without any separate key management step.
 */
export async function resolveApiKeyOwner(
  request: Pick<CoreRequest, "headers">,
  env: NodeJS.ProcessEnv = process.env,
  store?: ApiKeyStore | null,
): Promise<ApiKeyResolution> {
  const presented = presentedApiKey(request.headers);
  if (!presented) {
    return { authorized: false };
  }

  const keys = store === undefined ? tryCreateApiKeyStore(env) : store;
  if (!keys) {
    throw new ConfigurationError(
      STORAGE_CONNECTION_STRING_ENV,
      `${STORAGE_CONNECTION_STRING_ENV} is not configured.`,
    );
  }

  const email = await keys.resolve(presented);
  if (!email) {
    return { authorized: false };
  }

  const authorizedUsers = parseAuthorizedUsers(env[AUTHORIZED_USERS_ENV]);
  if (!authorizedUsers.has(email)) {
    return { authorized: false };
  }
  return { authorized: true, owner: notificationOwner(email) };
}
