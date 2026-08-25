import { createHash, randomUUID } from "node:crypto";
import { authorizeBrowserRequest } from "./auth.js";
import { requestOrigin, type CoreRequest, type CoreResponse } from "./http.js";
import { publicJwk, signJwt, type AccessTokenClaims } from "./oauth-jwt.js";
import {
  secretToken,
  tryCreateOAuthStore,
  type OAuthStore,
  type OAuthClient,
} from "./oauth-storage.js";

/** The one scope this resource server understands. */
export const MCP_SCOPE = "mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const JSON_NO_STORE = { ...NO_STORE, "Content-Type": "application/json" };

/** The audience every access token is minted for. */
export function resourceIdentifier(origin: string): string {
  return `${origin}/api/mcp`;
}

function oauthError(status: number, error: string, description: string): CoreResponse {
  return { status, headers: JSON_NO_STORE, jsonBody: { error, error_description: description } };
}

export function protectedResourceMetadata(origin: string): CoreResponse {
  return {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    jsonBody: {
      resource: resourceIdentifier(origin),
      authorization_servers: [origin],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/`,
    },
  };
}

export function authorizationServerMetadata(origin: string): CoreResponse {
  return {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
    jsonBody: {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      jwks_uri: `${origin}/oauth/jwks`,
      scopes_supported: [MCP_SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    },
  };
}

export async function handleJwksRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store = tryCreateOAuthStore(env),
): Promise<CoreResponse> {
  if (!store) {
    return oauthError(503, "temporarily_unavailable", "Storage is not configured.");
  }
  const key = await store.signingKey();
  return {
    status: 200,
    headers: { "Content-Type": "application/jwk-set+json", "Cache-Control": "public, max-age=300" },
    jsonBody: { keys: [publicJwk(key)] },
  };
}

/**
 * Dynamic client registration (RFC 7591), open because MCP clients cannot be
 * enrolled in advance. Registration grants nothing on its own: a client still
 * has to drive a human through sign-in and consent to obtain any token.
 */
export async function handleRegisterRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store = tryCreateOAuthStore(env),
  now: () => Date = () => new Date(),
): Promise<CoreResponse> {
  if (!store) {
    return oauthError(503, "temporarily_unavailable", "Storage is not configured.");
  }

  let body: { redirect_uris?: unknown; client_name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return oauthError(400, "invalid_client_metadata", "The request body is not JSON.");
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];
  if (redirectUris.length === 0 || !redirectUris.every(isUsableRedirectUri)) {
    return oauthError(
      400,
      "invalid_redirect_uri",
      "redirect_uris must be https, http on loopback, or a private-use scheme.",
    );
  }

  const client: OAuthClient = {
    clientId: randomUUID(),
    clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "",
    redirectUris,
    createdAt: now().getTime(),
  };
  await store.registerClient(client);

  return {
    status: 201,
    headers: JSON_NO_STORE,
    jsonBody: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

/** Loopback http is allowed because native clients have no other option. */
function isUsableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  }
  // A private-use scheme, as native applications register.
  return url.protocol.includes(".");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );
}

/**
 * The consent page carries its own policy. It has no scripts at all, so
 * inline styling cannot be an injection vector, and `form-action 'self'`
 * keeps the decision on this origin.
 */
const CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(status: number, title: string, content: string): CoreResponse {
  return {
    status,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CONSENT_CSP,
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#101014;color:#f2f2f7}main{max-width:26rem;padding:2rem;background:#1c1c22;border-radius:12px}h1{font-size:1.25rem;margin:0 0 1rem}p{margin:0 0 1rem;color:#c9c9d1}strong{color:#fff}form{display:flex;gap:.75rem;margin-top:1.5rem}button{flex:1;padding:.75rem;border-radius:8px;border:0;font:inherit;cursor:pointer}button[value=allow]{background:#4f8cff;color:#fff}button[value=deny]{background:#2a2a33;color:#f2f2f7}</style></head><body><main>${content}</main></body></html>`,
  };
}

interface AuthorizeParameters {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  challenge: string;
  scope: string;
  resource: string;
}

type AuthorizeValidation =
  | { ok: true; parameters: AuthorizeParameters }
  | { ok: false; response: CoreResponse }
  /** Errors that must be reported to the client rather than to the browser. */
  | { ok: false; redirect: string };

function parameterSource(request: CoreRequest, form: URLSearchParams | null) {
  return (name: string): string | null => (form ? form.get(name) : request.query.get(name));
}

async function validateAuthorize(
  request: CoreRequest,
  origin: string,
  store: OAuthStore,
  form: URLSearchParams | null,
): Promise<AuthorizeValidation> {
  const parameter = parameterSource(request, form);
  const clientId = parameter("client_id");
  const client = clientId ? await store.readClient(clientId) : null;
  if (!client) {
    return {
      ok: false,
      response: page(
        400,
        "Unknown application",
        "<h1>Unknown application</h1><p>This application is not registered, so the request cannot be trusted.</p>",
      ),
    };
  }

  const redirectUri = parameter("redirect_uri") ?? client.redirectUris[0] ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      response: page(
        400,
        "Unrecognised redirect",
        "<h1>Unrecognised redirect</h1><p>The application asked to be returned to an address it did not register.</p>",
      ),
    };
  }

  const state = parameter("state");
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    redirect: redirectTo(redirectUri, origin, state, { error, error_description: description }),
  });

  if (parameter("response_type") !== "code") {
    return fail("unsupported_response_type", "Only the authorization code flow is supported.");
  }
  const challenge = parameter("code_challenge");
  if (!challenge || parameter("code_challenge_method") !== "S256") {
    return fail("invalid_request", "A S256 code challenge is required.");
  }
  const resource = parameter("resource");
  if (resource !== null && resource !== resourceIdentifier(origin)) {
    return fail("invalid_target", "This authorization server protects a different resource.");
  }
  const requested = (parameter("scope") ?? MCP_SCOPE).split(/\s+/).filter(Boolean);
  if (!requested.every((scope) => scope === MCP_SCOPE)) {
    return fail("invalid_scope", `The only supported scope is ${MCP_SCOPE}.`);
  }

  return {
    ok: true,
    parameters: {
      client,
      redirectUri,
      state,
      challenge,
      scope: MCP_SCOPE,
      resource: resourceIdentifier(origin),
    },
  };
}

/** Builds the redirect back to the client, always carrying `iss` (RFC 9207). */
function redirectTo(
  redirectUri: string,
  origin: string,
  state: string | null,
  values: Record<string, string>,
): string {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries({ ...values, iss: origin })) {
    target.searchParams.set(name, value);
  }
  if (state !== null) {
    target.searchParams.set("state", state);
  }
  return target.toString();
}

function seeOther(location: string): CoreResponse {
  return { status: 302, headers: { ...NO_STORE, Location: location } };
}

function hiddenFields(request: CoreRequest): string {
  const url = new URL(request.url);
  const names = [
    "client_id",
    "redirect_uri",
    "state",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "resource",
  ];
  return names
    .map((name) => {
      const value = url.searchParams.get(name);
      return value === null
        ? ""
        : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    })
    .join("");
}

/**
 * Presents the consent screen. Sign-in is the host's ordinary browser session,
 * so an unauthenticated visitor is sent through it and returned here.
 */
export async function handleAuthorizeRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store = tryCreateOAuthStore(env),
): Promise<CoreResponse> {
  if (!store) {
    return oauthError(503, "temporarily_unavailable", "Storage is not configured.");
  }
  const origin = requestOrigin(request);
  const url = new URL(request.url);

  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    if (authorization.status === 401) {
      const target = encodeURIComponent(`${url.pathname}${url.search}`);
      return seeOther(`/.auth/login/aad?post_login_redirect_uri=${target}`);
    }
    return page(
      authorization.status,
      "Not authorized",
      `<h1>Not authorized</h1><p>${escapeHtml(authorization.error)}</p>`,
    );
  }

  const validation = await validateAuthorize(request, origin, store, null);
  if (!validation.ok) {
    return "redirect" in validation ? seeOther(validation.redirect) : validation.response;
  }

  const name = validation.parameters.client.clientName || "An application";
  return page(
    200,
    "Authorize access",
    `<h1>Authorize access</h1><p><strong>${escapeHtml(name)}</strong> is asking to send notifications as <strong>${escapeHtml(authorization.email)}</strong>.</p><p>It will be able to send you notifications until you revoke it. It cannot read your notification history.</p><form method="post" action="${escapeHtml(url.pathname)}">${hiddenFields(request)}<button name="decision" value="deny" type="submit">Deny</button><button name="decision" value="allow" type="submit">Allow</button></form>`,
  );
}

/** Records the decision. The form is same-origin and the session cookie is Lax. */
export async function handleAuthorizeDecision(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store = tryCreateOAuthStore(env),
  now: () => Date = () => new Date(),
): Promise<CoreResponse> {
  if (!store) {
    return oauthError(503, "temporarily_unavailable", "Storage is not configured.");
  }
  const authorization = authorizeBrowserRequest(request, env);
  if (!authorization.authorized) {
    return page(
      authorization.status,
      "Not authorized",
      `<h1>Not authorized</h1><p>${escapeHtml(authorization.error)}</p>`,
    );
  }

  const origin = requestOrigin(request);
  const form = new URLSearchParams(await request.text());
  const validation = await validateAuthorize(request, origin, store, form);
  if (!validation.ok) {
    return "redirect" in validation ? seeOther(validation.redirect) : validation.response;
  }
  const { client, redirectUri, state, challenge, scope, resource } = validation.parameters;

  if (form.get("decision") !== "allow") {
    return seeOther(
      redirectTo(redirectUri, origin, state, {
        error: "access_denied",
        error_description: "The account holder declined the request.",
      }),
    );
  }

  const code = secretToken();
  await store.saveCode(code, {
    clientId: client.clientId,
    email: authorization.email,
    redirectUri,
    challenge,
    resource,
    scope,
    exp: Math.floor(now().getTime() / 1000) + CODE_TTL_SECONDS,
  });
  return seeOther(redirectTo(redirectUri, origin, state, { code }));
}

function accessToken(
  origin: string,
  grant: { email: string; clientId: string; scope: string; resource: string },
  key: Awaited<ReturnType<OAuthStore["signingKey"]>>,
  issuedAt: number,
): string {
  const claims: AccessTokenClaims = {
    iss: origin,
    sub: grant.email,
    aud: grant.resource,
    email: grant.email,
    scope: grant.scope,
    client_id: grant.clientId,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  return signJwt(claims, key);
}

export async function handleTokenRequest(
  request: CoreRequest,
  env: NodeJS.ProcessEnv = process.env,
  store = tryCreateOAuthStore(env),
  now: () => Date = () => new Date(),
): Promise<CoreResponse> {
  if (!store) {
    return oauthError(503, "temporarily_unavailable", "Storage is not configured.");
  }
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type");
  const issuedAt = Math.floor(now().getTime() / 1000);
  const origin = requestOrigin(request);

  const grant =
    grantType === "authorization_code"
      ? await redeemCode(form, store)
      : grantType === "refresh_token"
        ? await redeemRefresh(form, store)
        : { error: oauthError(400, "unsupported_grant_type", `Unsupported grant: ${grantType}.`) };
  if ("error" in grant) {
    return grant.error;
  }

  const refresh = secretToken();
  await store.saveRefresh(refresh, {
    clientId: grant.clientId,
    email: grant.email,
    resource: grant.resource,
    scope: grant.scope,
    exp: issuedAt + REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    status: 200,
    headers: JSON_NO_STORE,
    jsonBody: {
      access_token: accessToken(origin, grant, await store.signingKey(), issuedAt),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh,
      scope: grant.scope,
    },
  };
}

interface ResolvedGrant {
  clientId: string;
  email: string;
  scope: string;
  resource: string;
}

async function redeemCode(
  form: URLSearchParams,
  store: OAuthStore,
): Promise<ResolvedGrant | { error: CoreResponse }> {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  if (!code || !verifier) {
    return { error: oauthError(400, "invalid_request", "code and code_verifier are required.") };
  }

  const grant = await store.consumeCode(code);
  const invalid = { error: oauthError(400, "invalid_grant", "The authorization code is not valid.") };
  if (!grant) {
    return invalid;
  }
  if (grant.clientId !== form.get("client_id")) {
    return invalid;
  }
  const redirectUri = form.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== grant.redirectUri) {
    return invalid;
  }
  const presented = createHash("sha256").update(verifier).digest("base64url");
  if (presented !== grant.challenge) {
    return invalid;
  }
  return grant;
}

async function redeemRefresh(
  form: URLSearchParams,
  store: OAuthStore,
): Promise<ResolvedGrant | { error: CoreResponse }> {
  const token = form.get("refresh_token");
  const grant = token ? await store.consumeRefresh(token) : null;
  if (!grant || grant.clientId !== form.get("client_id")) {
    return { error: oauthError(400, "invalid_grant", "The refresh token is not valid.") };
  }
  return grant;
}
