import type { HttpRequest } from "@azure/functions";
import { AUTHORIZED_USERS_ENV, parseAuthorizedUsers } from "./auth.js";
import { tryCreateApiKeyStore, type ApiKeyStore } from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import { notificationOwner, type NotificationOwner } from "./identity.js";
import { STORAGE_CONNECTION_STRING_ENV } from "./table-storage.js";

export type ApiKeyResolution =
  | { authorized: true; owner: NotificationOwner }
  | { authorized: false };

/**
 * Resolves the presented key to the account that owns it. Authorization is
 * re-evaluated on every request, so removing an address from AUTHORIZED_USERS
 * revokes its key immediately without any separate key management step.
 */
export async function resolveApiKeyOwner(
  request: Pick<HttpRequest, "headers">,
  env: NodeJS.ProcessEnv = process.env,
  store?: ApiKeyStore | null,
): Promise<ApiKeyResolution> {
  const presented = request.headers.get("x-api-key");
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
