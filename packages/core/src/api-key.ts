import { requestOrigin, type CoreRequest, type CoreHeaders } from "./http.js";
import { AUTHORIZED_USERS_ENV, parseAuthorizedUsers } from "./auth.js";
import {
  API_KEY_PREFIX,
  tryCreateApiKeyStore,
  type ApiKeyStore,
} from "./api-key-storage.js";
import { ConfigurationError } from "./configuration.js";
import { notificationOwner, type NotificationOwner } from "./identity.js";
import { verifyJwt } from "./oauth-jwt.js";
import { MCP_SCOPE, resourceIdentifier } from "./oauth-server.js";
import { tryCreateOAuthStore, type OAuthStore } from "./oauth-storage.js";
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
 * Resolves the presented credential to the account it acts for.
 *
 * A credential is either an API key, which carries the `ncli_` prefix, or an
 * access token this server issued. The prefix is what tells them apart, so one
 * `Authorization: Bearer` header serves OAuth clients and, for clients that
 * cannot do OAuth, the key they can paste in.
 *
 * Authorization is re-evaluated on every request, so removing an address from
 * AUTHORIZED_USERS revokes both kinds of credential immediately.
 */
export async function resolveApiKeyOwner(
  request: Pick<CoreRequest, "headers" | "url">,
  env: NodeJS.ProcessEnv = process.env,
  store?: ApiKeyStore | null,
  oauth?: OAuthStore | null,
): Promise<ApiKeyResolution> {
  const presented = presentedApiKey(request.headers);
  if (!presented) {
    return { authorized: false };
  }

  const email = presented.startsWith(API_KEY_PREFIX)
    ? await resolveKey(presented, env, store)
    : await resolveAccessToken(presented, requestOrigin(request), env, oauth);
  if (!email) {
    return { authorized: false };
  }

  const authorizedUsers = parseAuthorizedUsers(env[AUTHORIZED_USERS_ENV]);
  if (!authorizedUsers.has(email)) {
    return { authorized: false };
  }
  return { authorized: true, owner: notificationOwner(email) };
}

async function resolveKey(
  presented: string,
  env: NodeJS.ProcessEnv,
  store?: ApiKeyStore | null,
): Promise<string | null> {
  const keys = store === undefined ? tryCreateApiKeyStore(env) : store;
  if (!keys) {
    throw new ConfigurationError(
      STORAGE_CONNECTION_STRING_ENV,
      `${STORAGE_CONNECTION_STRING_ENV} is not configured.`,
    );
  }
  return keys.resolve(presented);
}

/**
 * A token is only accepted for the origin that issued it and for this
 * resource, so a token minted for another deployment is worthless here.
 */
async function resolveAccessToken(
  presented: string,
  origin: string,
  env: NodeJS.ProcessEnv,
  store?: OAuthStore | null,
): Promise<string | null> {
  const oauth = store === undefined ? tryCreateOAuthStore(env) : store;
  if (!oauth) {
    return null;
  }
  const claims = verifyJwt(presented, [await oauth.signingKey()]);
  if (!claims) {
    return null;
  }
  if (claims.iss !== origin || claims.aud !== resourceIdentifier(origin)) {
    return null;
  }
  if (!claims.scope.split(/\s+/).includes(MCP_SCOPE)) {
    return null;
  }
  return claims.email.trim().toLowerCase();
}
