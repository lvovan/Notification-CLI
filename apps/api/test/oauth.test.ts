import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { requestOrigin } from "@notification-cli/core/http";
import type { CoreRequest, CoreResponse } from "@notification-cli/core/http";
import { resolveApiKeyOwner } from "@notification-cli/core/api-key";
import { handleMcpRequest } from "@notification-cli/core/mcp";
import { generateSigningKey, signJwt, verifyJwt } from "@notification-cli/core/oauth-jwt";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authorizationServerMetadata,
  handleAuthorizeDecision,
  handleAuthorizeRequest,
  handleJwksRequest,
  handleRegisterRequest,
  handleTokenRequest,
  protectedResourceMetadata,
  resourceIdentifier,
} from "@notification-cli/core/oauth-server";
import type {
  AuthorizationCode,
  OAuthClient,
  OAuthStore,
  RefreshGrant,
} from "@notification-cli/core/oauth-storage";

const ORIGIN = "https://notify.example.com";
const RESOURCE = `${ORIGIN}/api/mcp`;
const OWNER = "user@example.com";
const REDIRECT = "http://127.0.0.1:33418/callback";
const env = { AUTHORIZED_USERS: OWNER };

class MemoryOAuthStore implements OAuthStore {
  readonly key = generateSigningKey();
  readonly clients = new Map<string, OAuthClient>();
  readonly codes = new Map<string, AuthorizationCode>();
  readonly refreshTokens = new Map<string, RefreshGrant>();

  signingKey() {
    return Promise.resolve(this.key);
  }
  registerClient(client: OAuthClient) {
    this.clients.set(client.clientId, client);
    return Promise.resolve();
  }
  readClient(clientId: string) {
    return Promise.resolve(this.clients.get(clientId) ?? null);
  }
  saveCode(code: string, grant: AuthorizationCode) {
    this.codes.set(code, grant);
    return Promise.resolve();
  }
  consumeCode(code: string) {
    return Promise.resolve(this.take(this.codes, code));
  }
  saveRefresh(token: string, grant: RefreshGrant) {
    this.refreshTokens.set(token, grant);
    return Promise.resolve();
  }
  consumeRefresh(token: string) {
    return Promise.resolve(this.take(this.refreshTokens, token));
  }

  private take<T extends { exp: number }>(from: Map<string, T>, value: string): T | null {
    const grant = from.get(value);
    from.delete(value);
    return grant && grant.exp * 1000 > Date.now() ? grant : null;
  }
}

function principalHeader(email = OWNER): string {
  return Buffer.from(
    JSON.stringify({
      identityProvider: "aad",
      userId: email,
      userDetails: email,
      userRoles: ["authenticated"],
    }),
  ).toString("base64");
}

function request(
  method: string,
  path: string,
  options: { signedIn?: boolean; body?: string } = {},
): CoreRequest {
  const url = new URL(path, ORIGIN);
  const headers = new Headers(
    options.signedIn === false ? {} : { "x-ms-client-principal": principalHeader() },
  );
  return {
    method,
    url: url.toString(),
    headers,
    query: url.searchParams,
    text: () => Promise.resolve(options.body ?? ""),
    json: () => Promise.resolve(JSON.parse(options.body ?? "null") as unknown),
  };
}

function location(response: CoreResponse): URL {
  assert.equal(response.status, 302, JSON.stringify(response.jsonBody));
  return new URL(response.headers?.["Location"] ?? "");
}

async function registerClient(store: OAuthStore): Promise<string> {
  const response = await handleRegisterRequest(
    request("POST", "/oauth/register", {
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Copilot <CLI>" }),
    }),
    env,
    store,
  );
  assert.equal(response.status, 201);
  return (response.jsonBody as { client_id: string }).client_id;
}

interface Pkce {
  verifier: string;
  challenge: string;
}

function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeQuery(clientId: string, challenge: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    resource: RESOURCE,
    state: "opaque-state",
    ...overrides,
  });
}

/** Drives registration, consent and the code exchange the way a client does. */
async function completeFlow(store: OAuthStore): Promise<Record<string, unknown>> {
  const clientId = await registerClient(store);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge);

  const consent = await handleAuthorizeDecision(
    request("POST", "/oauth/authorize", {
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: "allow" }).toString(),
    }),
    env,
    store,
  );
  const code = location(consent).searchParams.get("code") ?? "";

  const token = await handleTokenRequest(
    request("POST", "/oauth/token", {
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      }).toString(),
    }),
    env,
    store,
  );
  assert.equal(token.status, 200, JSON.stringify(token.jsonBody));
  return token.jsonBody as Record<string, unknown>;
}

test("the protected resource points at this origin's authorization server", () => {
  assert.deepEqual(protectedResourceMetadata(ORIGIN).jsonBody, {
    resource: RESOURCE,
    authorization_servers: [ORIGIN],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${ORIGIN}/`,
  });
});

test("the authorization server advertises only what it implements", () => {
  const metadata = authorizationServerMetadata(ORIGIN).jsonBody as Record<string, unknown>;
  assert.equal(metadata["issuer"], ORIGIN);
  assert.equal(metadata["registration_endpoint"], `${ORIGIN}/oauth/register`);
  assert.deepEqual(metadata["code_challenge_methods_supported"], ["S256"]);
  assert.deepEqual(metadata["grant_types_supported"], ["authorization_code", "refresh_token"]);
  // Public clients only: the code is bound by PKCE rather than by a secret.
  assert.deepEqual(metadata["token_endpoint_auth_methods_supported"], ["none"]);
  assert.equal(metadata["authorization_response_iss_parameter_supported"], true);
});

test("the JWKS publishes the public half of the signing key alone", async () => {
  const store = new MemoryOAuthStore();
  const response = await handleJwksRequest(request("GET", "/oauth/jwks"), env, store);
  const { keys } = response.jsonBody as { keys: Array<Record<string, unknown>> };
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.["kid"], store.key.kid);
  assert.equal(keys[0]?.["alg"], "ES256");
  assert.equal(keys[0]?.["d"], undefined);
});

test("registration accepts the redirect shapes clients can actually use", async () => {
  const store = new MemoryOAuthStore();
  for (const uri of ["https://client.example/cb", REDIRECT, "com.example.app:/callback"]) {
    const response = await handleRegisterRequest(
      request("POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: [uri] }) }),
      env,
      store,
    );
    assert.equal(response.status, 201, uri);
  }
});

test("registration refuses redirects that cannot be trusted", async () => {
  const store = new MemoryOAuthStore();
  for (const uri of ["http://client.example/cb", "https://client.example/cb#fragment", "nonsense"]) {
    const response = await handleRegisterRequest(
      request("POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: [uri] }) }),
      env,
      store,
    );
    assert.equal(response.status, 400, uri);
  }
  assert.equal(
    (
      await handleRegisterRequest(
        request("POST", "/oauth/register", { body: JSON.stringify({}) }),
        env,
        store,
      )
    ).status,
    400,
  );
});

test("an unauthenticated visitor is sent through sign-in and back", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const query = authorizeQuery(clientId, pkce().challenge);

  const response = await handleAuthorizeRequest(
    request("GET", `/oauth/authorize?${query.toString()}`, { signedIn: false }),
    env,
    store,
  );
  assert.equal(response.status, 302);
  const target = response.headers?.["Location"] ?? "";
  assert.ok(target.startsWith("/.auth/login/aad?post_login_redirect_uri="));
  assert.match(decodeURIComponent(target), /\/oauth\/authorize\?client_id=/);
});

test("an unauthorized account is told so rather than redirected", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const response = await handleAuthorizeRequest(
    request("GET", `/oauth/authorize?${authorizeQuery(clientId, pkce().challenge).toString()}`),
    { AUTHORIZED_USERS: "someone.else@example.com" },
    store,
  );
  assert.equal(response.status, 403);
  assert.match(response.body ?? "", /Not authorized/);
});

test("the consent page names the client and the account, escaped", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const response = await handleAuthorizeRequest(
    request("GET", `/oauth/authorize?${authorizeQuery(clientId, pkce().challenge).toString()}`),
    env,
    store,
  );
  assert.equal(response.status, 200);
  const body = response.body ?? "";
  assert.match(body, /Copilot &lt;CLI&gt;/);
  assert.ok(!body.includes("Copilot <CLI>"));
  assert.match(body, /user@example\.com/);
  // The decision must come back to this origin only.
  assert.match(response.headers?.["Content-Security-Policy"] ?? "", /form-action 'self'/);
});

test("an unregistered client or redirect never reaches the client", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);

  const unknownClient = await handleAuthorizeRequest(
    request("GET", `/oauth/authorize?${authorizeQuery("not-a-client", "x").toString()}`),
    env,
    store,
  );
  assert.equal(unknownClient.status, 400);
  assert.equal(unknownClient.headers?.["Location"], undefined);

  const badRedirect = await handleAuthorizeRequest(
    request(
      "GET",
      `/oauth/authorize?${authorizeQuery(clientId, "x", {
        redirect_uri: "https://evil.example/cb",
      }).toString()}`,
    ),
    env,
    store,
  );
  assert.equal(badRedirect.status, 400);
  assert.equal(badRedirect.headers?.["Location"], undefined);
});

test("protocol errors are reported to the client with the state and issuer", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const cases: Array<[Record<string, string>, string]> = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ resource: "https://other.example/api/mcp" }, "invalid_target"],
    [{ scope: "mcp admin" }, "invalid_scope"],
  ];

  for (const [overrides, expected] of cases) {
    const response = await handleAuthorizeRequest(
      request(
        "GET",
        `/oauth/authorize?${authorizeQuery(clientId, pkce().challenge, overrides).toString()}`,
      ),
      env,
      store,
    );
    const target = location(response);
    assert.equal(target.searchParams.get("error"), expected);
    assert.equal(target.searchParams.get("state"), "opaque-state");
    assert.equal(target.searchParams.get("iss"), ORIGIN);
  }
});

test("declining consent returns access_denied and mints nothing", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const query = authorizeQuery(clientId, pkce().challenge);

  const response = await handleAuthorizeDecision(
    request("POST", "/oauth/authorize", {
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: "deny" }).toString(),
    }),
    env,
    store,
  );
  assert.equal(location(response).searchParams.get("error"), "access_denied");
  assert.equal(store.codes.size, 0);
});

test("consent yields a token that names the account and this resource", async () => {
  const store = new MemoryOAuthStore();
  const tokens = await completeFlow(store);

  assert.equal(tokens["token_type"], "Bearer");
  assert.equal(tokens["expires_in"], ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(tokens["scope"], "mcp");
  assert.ok(typeof tokens["refresh_token"] === "string");

  const claims = verifyJwt(String(tokens["access_token"]), [store.key]);
  assert.ok(claims);
  assert.equal(claims.iss, ORIGIN);
  assert.equal(claims.aud, RESOURCE);
  assert.equal(claims.email, OWNER);
  assert.equal(claims.scope, "mcp");
});

test("a code is bound to its verifier and works only once", async () => {
  const store = new MemoryOAuthStore();
  const clientId = await registerClient(store);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge);

  const consent = await handleAuthorizeDecision(
    request("POST", "/oauth/authorize", {
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: "allow" }).toString(),
    }),
    env,
    store,
  );
  const code = location(consent).searchParams.get("code") ?? "";

  const exchange = (parameters: Record<string, string>) =>
    handleTokenRequest(
      request("POST", "/oauth/token", {
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT,
          ...parameters,
        }).toString(),
      }),
      env,
      store,
    );

  const wrongVerifier = await exchange({ code_verifier: pkce().verifier });
  assert.equal(wrongVerifier.status, 400);
  assert.equal((wrongVerifier.jsonBody as { error: string }).error, "invalid_grant");

  // The failed attempt still consumed the code, so a stolen code is spent.
  const replay = await exchange({ code_verifier: verifier });
  assert.equal(replay.status, 400);
});

test("a refresh token is rotated on use and the old one dies", async () => {
  const store = new MemoryOAuthStore();
  const tokens = await completeFlow(store);
  const clientId = String(
    verifyJwt(String(tokens["access_token"]), [store.key])?.client_id,
  );

  const refresh = (token: string) =>
    handleTokenRequest(
      request("POST", "/oauth/token", {
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: clientId,
        }).toString(),
      }),
      env,
      store,
    );

  const rotated = await refresh(String(tokens["refresh_token"]));
  assert.equal(rotated.status, 200);
  const next = (rotated.jsonBody as Record<string, unknown>)["refresh_token"];
  assert.notEqual(next, tokens["refresh_token"]);

  const reused = await refresh(String(tokens["refresh_token"]));
  assert.equal(reused.status, 400);
});

test("an unsupported grant is refused", async () => {
  const store = new MemoryOAuthStore();
  const response = await handleTokenRequest(
    request("POST", "/oauth/token", { body: "grant_type=password" }),
    env,
    store,
  );
  assert.equal(response.status, 400);
  assert.equal((response.jsonBody as { error: string }).error, "unsupported_grant_type");
});

test("an access token authorizes the MCP endpoint like an API key does", async () => {
  const store = new MemoryOAuthStore();
  const tokens = await completeFlow(store);
  const resolution = await resolveApiKeyOwner(
    {
      url: RESOURCE,
      headers: new Headers({ authorization: `Bearer ${String(tokens["access_token"])}` }),
    },
    env,
    null,
    store,
  );
  assert.equal(resolution.authorized && resolution.owner.email, OWNER);
});

test("a token minted elsewhere or for another resource is worthless", async () => {
  const store = new MemoryOAuthStore();
  const issuedAt = Math.floor(Date.now() / 1000);
  const base = {
    sub: OWNER,
    email: OWNER,
    scope: "mcp",
    client_id: "client",
    iat: issuedAt,
    exp: issuedAt + 60,
    jti: "one",
  };

  const rejected = [
    signJwt({ ...base, iss: "https://elsewhere.example", aud: RESOURCE }, store.key),
    signJwt({ ...base, iss: ORIGIN, aud: "https://elsewhere.example/api/mcp" }, store.key),
    signJwt({ ...base, iss: ORIGIN, aud: RESOURCE, scope: "other" }, store.key),
    signJwt({ ...base, iss: ORIGIN, aud: RESOURCE, exp: issuedAt - 1 }, store.key),
    // Correct in every way except that another key signed it.
    signJwt({ ...base, iss: ORIGIN, aud: RESOURCE }, generateSigningKey()),
  ];

  for (const token of rejected) {
    const resolution = await resolveApiKeyOwner(
      { url: RESOURCE, headers: new Headers({ authorization: `Bearer ${token}` }) },
      env,
      null,
      store,
    );
    assert.deepEqual(resolution, { authorized: false }, token.slice(0, 24));
  }
});

test("a token whose account left the allowlist stops working at once", async () => {
  const store = new MemoryOAuthStore();
  const tokens = await completeFlow(store);
  const resolution = await resolveApiKeyOwner(
    {
      url: RESOURCE,
      headers: new Headers({ authorization: `Bearer ${String(tokens["access_token"])}` }),
    },
    { AUTHORIZED_USERS: "someone.else@example.com" },
    null,
    store,
  );
  assert.deepEqual(resolution, { authorized: false });
});

test("an unauthenticated MCP call advertises where to get a token", async () => {
  const response = await handleMcpRequest(
    request("POST", "/api/mcp", { signedIn: false }),
    env,
    undefined,
    undefined,
    null,
    new MemoryOAuthStore(),
  );
  assert.equal(response.status, 401);
  assert.equal(
    response.headers?.["WWW-Authenticate"],
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
  );
});


// Behind Static Web Apps the request URL names the internal Functions host, so
// a client told to look there would never find the metadata.
test("discovery follows the forwarded host rather than the internal one", async () => {
  const internal = {
    ...request("POST", "/api/mcp", { signedIn: false }),
    url: "https://internal.azurewebsites.net/api/mcp",
    headers: new Headers({
      "x-forwarded-host": "notify.example.com",
      "x-forwarded-proto": "https",
    }),
  };

  const response = await handleMcpRequest(
    internal,
    env,
    undefined,
    undefined,
    null,
    new MemoryOAuthStore(),
  );

  assert.equal(response.status, 401);
  assert.equal(
    response.headers?.["WWW-Authenticate"],
    `Bearer resource_metadata="https://notify.example.com/.well-known/oauth-protected-resource/api/mcp"`,
  );
  assert.equal(
    (protectedResourceMetadata(requestOrigin(internal)).jsonBody as { resource: string }).resource,
    "https://notify.example.com/api/mcp",
  );
});
