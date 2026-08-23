import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import {
  authorizeBrowserRequest,
  normalizeEmail,
  parseAuthorizedUsers,
  parseClientPrincipal,
} from "../src/auth.js";
import {
  handleNegotiateRequest,
  handleSessionRequest,
} from "../src/browser.js";

function requestFor(
  userDetails = " User@Example.COM ",
  overrides: Record<string, unknown> = {},
): HttpRequest {
  const principal = {
    identityProvider: "aad",
    userId: "user-id",
    userDetails,
    userRoles: ["anonymous", "authenticated"],
    ...overrides,
  };
  return {
    headers: new Headers({
      "x-ms-client-principal": Buffer.from(
        JSON.stringify(principal),
      ).toString("base64"),
    }),
  } as HttpRequest;
}

test("normalizes and parses the semicolon-separated allowlist", () => {
  assert.equal(normalizeEmail(" User@Example.COM "), "user@example.com");
  assert.deepEqual(
    [...parseAuthorizedUsers(" A@Example.com ; ;b@example.COM; a@example.com")],
    ["a@example.com", "b@example.com"],
  );
});

test("parses a valid SWA principal and rejects malformed principals", () => {
  const request = requestFor();
  assert.equal(
    parseClientPrincipal(request.headers.get("x-ms-client-principal"))
      ?.userDetails,
    " User@Example.COM ",
  );
  assert.equal(parseClientPrincipal("not-base64-json"), null);
  assert.equal(
    parseClientPrincipal(
      Buffer.from(JSON.stringify({ identityProvider: "aad" })).toString(
        "base64",
      ),
    ),
    null,
  );
});

test("authorizes only allowlisted authenticated AAD email addresses", () => {
  const env = { AUTHORIZED_USERS: "other@example.com; USER@example.com " };
  assert.deepEqual(authorizeBrowserRequest(requestFor(), env), {
    authorized: true,
    email: "user@example.com",
  });

  const denied = authorizeBrowserRequest(requestFor("no@example.com"), env);
  assert.equal(denied.authorized, false);
  assert.equal(denied.status, 403);

  const wrongProvider = authorizeBrowserRequest(
    requestFor("user@example.com", { identityProvider: "github" }),
    env,
  );
  assert.equal(wrongProvider.authorized, false);
  assert.equal(wrongProvider.status, 401);
});

test("fails closed when AUTHORIZED_USERS or the principal is absent", () => {
  const missingAllowlist = authorizeBrowserRequest(requestFor(), {});
  assert.equal(missingAllowlist.authorized, false);
  assert.equal(missingAllowlist.status, 503);

  const noPrincipal = authorizeBrowserRequest(
    { headers: new Headers() },
    { AUTHORIZED_USERS: "user@example.com" },
  );
  assert.equal(noPrincipal.authorized, false);
  assert.equal(noPrincipal.status, 401);
});

test("uses an email claim when supplied by the SWA principal", () => {
  const authorization = authorizeBrowserRequest(
    requestFor("display name", {
      claims: [{ typ: "email", val: " Claimed@Example.com " }],
    }),
    { AUTHORIZED_USERS: "claimed@example.com" },
  );
  assert.deepEqual(authorization, {
    authorized: true,
    email: "claimed@example.com",
  });
});

test("session reports authorization without caching", () => {
  const response = handleSessionRequest(requestFor(), {
    AUTHORIZED_USERS: "user@example.com",
  });
  assert.equal(response.status, 200);
  assert.equal(new Headers(response.headers).get("Cache-Control"), "no-store");
  assert.deepEqual(response.jsonBody, {
    authenticated: true,
    authorized: true,
    email: "user@example.com",
  });

  const denied = handleSessionRequest(requestFor(), {
    AUTHORIZED_USERS: "other@example.com",
  });
  assert.equal(denied.status, 403);
  assert.equal((denied.jsonBody as { authorized: boolean }).authorized, false);
});

test("negotiate enforces authorization before issuing a token", async () => {
  let calls = 0;
  const createClient = () => ({
    getClientAccessToken: async () => {
      calls += 1;
      return { url: "wss://example.test/client" };
    },
  });

  const denied = await handleNegotiateRequest(
    requestFor(),
    { AUTHORIZED_USERS: "other@example.com" },
    createClient,
  );
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);

  const accepted = await handleNegotiateRequest(
    requestFor(),
    { AUTHORIZED_USERS: "user@example.com" },
    createClient,
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.jsonBody, {
    url: "wss://example.test/client",
  });
  assert.equal(calls, 1);
});
