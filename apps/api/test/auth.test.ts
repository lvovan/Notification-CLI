import assert from "node:assert/strict";
import test from "node:test";
import type { HttpRequest } from "@azure/functions";
import {
  authorizeBrowserRequest,
  normalizeEmail,
  parseClientPrincipal,
} from "@notification-cli/core/auth";
import {
  handleNegotiateRequest,
  handleSessionRequest,
} from "@notification-cli/core/browser";

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

test("normalizes email addresses", () => {
  assert.equal(normalizeEmail(" User@Example.COM "), "user@example.com");
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

test("authorizes authenticated AAD principals without environment configuration", () => {
  assert.deepEqual(authorizeBrowserRequest(requestFor()), {
    authorized: true,
    email: "user@example.com",
  });
});

test("rejects missing or non-AAD authenticated principals", () => {
  const noPrincipal = authorizeBrowserRequest({ headers: new Headers() });
  assert.equal(noPrincipal.authorized, false);
  assert.equal(noPrincipal.authenticated, false);

  const wrongProvider = authorizeBrowserRequest(
    requestFor("user@example.com", { identityProvider: "github" }),
  );
  assert.equal(wrongProvider.authorized, false);
  assert.equal(wrongProvider.authenticated, false);

  const missingRole = authorizeBrowserRequest(
    requestFor("user@example.com", { userRoles: ["anonymous"] }),
  );
  assert.equal(missingRole.authorized, false);
  assert.equal(missingRole.authenticated, false);
});

test("treats a principal without an email as an expired session, not a denial", () => {
  const authorization = authorizeBrowserRequest(requestFor("  "));
  assert.equal(authorization.authorized, false);
  assert.equal(authorization.authenticated, true);
  assert.match(authorization.error ?? "", /did not include an email address/);
});

test("uses an email claim when supplied by the SWA principal", () => {
  const authorization = authorizeBrowserRequest(
    requestFor("display name", {
      claims: [{ typ: "email", val: " Claimed@Example.com " }],
    }),
  );
  assert.deepEqual(authorization, {
    authorized: true,
    email: "claimed@example.com",
  });
});

test("session reports authentication without caching", () => {
  const response = handleSessionRequest(requestFor());
  assert.equal(response.status, 200);
  assert.equal(new Headers(response.headers).get("Cache-Control"), "no-store");
  assert.deepEqual(response.jsonBody, {
    authenticated: true,
    email: "user@example.com",
  });

  const denied = handleSessionRequest({ headers: new Headers() } as HttpRequest);
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.jsonBody, {
    authenticated: false,
    error: "Microsoft account sign-in is required.",
  });
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
    { headers: new Headers() } as HttpRequest,
    createClient,
  );
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);

  const accepted = await handleNegotiateRequest(
    requestFor(),
    createClient,
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.jsonBody, {
    url: "wss://example.test/client",
  });
  assert.equal(calls, 1);
});
