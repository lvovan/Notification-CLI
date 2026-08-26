import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { ClientAssertionCallback } from "@azure/msal-node";
import type { AddressInfo } from "node:net";
import { ConfigurationError } from "@notification-cli/core/configuration";
import {
  clientCredential,
  createEntraSessionProvider,
  createMsalAuthClient,
  parseCookies,
  readEntraConfig,
  type AuthClient,
  type EntraConfig,
} from "../src/entra.js";
import { lazySessionProvider } from "../src/session.js";
import { createNotificationServer } from "../src/server.js";

const OWNER = "user@example.com";

const CONFIG: EntraConfig = {
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  sessionSecret: "a-secret-long-enough-to-sign-with",
};

const PUBLIC_CONFIG: EntraConfig = {
  tenantId: CONFIG.tenantId,
  clientId: CONFIG.clientId,
  sessionSecret: CONFIG.sessionSecret,
};

/** Stands in for MSAL, recording what it was asked so tests can assert on it. */
function fakeClient(redeem?: AuthClient["redeemCode"]): AuthClient & {
  authorize?: Parameters<AuthClient["authorizeUrl"]>[0];
} {
  const client: AuthClient & { authorize?: Parameters<AuthClient["authorizeUrl"]>[0] } = {
    authorizeUrl: (request) => {
      client.authorize = request;
      const url = new URL("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize");
      url.search = new URLSearchParams({ state: request.state }).toString();
      return Promise.resolve(url.toString());
    },
    redeemCode: redeem ?? (() => Promise.resolve({ preferred_username: OWNER.toUpperCase() })),
  };
  return client;
}

async function withServer(
  client: AuthClient,
  visit: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createNotificationServer({
    webRoot: process.cwd(),
    session: createEntraSessionProvider(CONFIG, client),
    logger: { error: () => {} },
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  try {
    await visit(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

/** Drives a full sign-in and returns the session cookie it produced. */
async function signIn(origin: string, forgeState?: (state: string) => string): Promise<string> {
  const start = await fetch(`${origin}/.auth/login/aad?post_login_redirect_uri=/history`, {
    redirect: "manual",
  });
  const authorize = new URL(start.headers.get("location") ?? "");
  const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const state = authorize.searchParams.get("state") ?? "";

  const callback = await fetch(
    `${origin}/.auth/login/aad/callback?code=abc&state=${encodeURIComponent(
      forgeState ? forgeState(state) : state,
    )}`,
    { redirect: "manual", headers: { cookie: flowCookie } },
  );
  if (callback.status !== 302) {
    return String(callback.status);
  }
  assert.equal(callback.headers.get("location"), "/history");
  const session = callback.headers.getSetCookie().find((value) => value.startsWith("ncli_session"));
  return (session ?? "").split(";")[0] ?? "";
}

test("the configuration must be complete", () => {
  assert.throws(() => readEntraConfig({}), ConfigurationError);
  assert.throws(() => readEntraConfig({}), /NOTIFICATION_CLI_ENTRA_TENANT_ID is not configured/);
});

// A tenant policy can forbid client secrets outright, so the secret is optional.
test("the client secret is optional", () => {
  const env = {
    NOTIFICATION_CLI_ENTRA_TENANT_ID: "tenant",
    NOTIFICATION_CLI_ENTRA_CLIENT_ID: "client",
    NOTIFICATION_CLI_SESSION_SECRET: "secret",
  };
  assert.equal(readEntraConfig(env).clientSecret, undefined);
  assert.equal(
    readEntraConfig({ ...env, NOTIFICATION_CLI_ENTRA_CLIENT_SECRET: " " }).clientSecret,
    undefined,
  );
});

test("a secret is preferred, then a managed identity, then nothing at all", async () => {
  const identity = { IDENTITY_ENDPOINT: "http://identity", IDENTITY_HEADER: "header" };

  assert.deepEqual(clientCredential(CONFIG, () => Promise.reject(new Error("unused")), identity), {
    clientSecret: "secret",
  });

  const federated = clientCredential(PUBLIC_CONFIG, () => Promise.resolve("assertion"), identity);
  const assertionCallback = federated.clientAssertion as ClientAssertionCallback;
  assert.equal(typeof assertionCallback, "function");
  assert.equal(await assertionCallback({ clientId: "client" }), "assertion");

  // PKCE alone binds the code to this server, so a public client sends nothing.
  assert.deepEqual(clientCredential(PUBLIC_CONFIG, () => Promise.resolve("unused"), {}), {});
});

test("MSAL accepts every credential arrangement", () => {
  assert.ok(createMsalAuthClient(CONFIG));
  assert.ok(createMsalAuthClient(PUBLIC_CONFIG));
});

// An unconfigured site has to boot: App Service replaces a process that exits
// with its own welcome page, which tells the operator nothing.
test("a missing sign-in setting is reported per request, not at startup", async () => {
  const server = createNotificationServer({
    webRoot: process.cwd(),
    session: lazySessionProvider(() => createEntraSessionProvider(readEntraConfig({}))),
    logger: { error: () => {} },
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "NOTIFICATION_CLI_ENTRA_TENANT_ID is not configured.",
    });

    // Discovery is anonymous, so it must answer even then: an MCP client has to
    // be able to find the authorization server before anyone can sign in.
    const discovery = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    assert.equal(discovery.status, 200);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
});

test("sign-in starts a PKCE code flow bound to a sealed cookie", async () => {
  const client = fakeClient();
  await withServer(client, async (origin) => {
    const response = await fetch(`${origin}/.auth/login/aad?post_login_redirect_uri=/history`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location") ?? "").origin, "https://login.microsoftonline.com");

    assert.ok(client.authorize?.state);
    assert.ok(client.authorize?.codeChallenge);
    assert.match(
      client.authorize?.redirectUri ?? "",
      /^https?:\/\/127\.0\.0\.1:\d+\/\.auth\/login\/aad\/callback$/,
    );

    const [flow] = response.headers.getSetCookie();
    assert.ok(flow?.startsWith("ncli_flow="));
    assert.match(flow ?? "", /HttpOnly/);
    assert.match(flow ?? "", /SameSite=Lax/);
  });
});

test("the code challenge is the S256 hash of the verifier that is later presented", async () => {
  let presented: string | undefined;
  const client = fakeClient((request) => {
    presented = request.codeVerifier;
    return Promise.resolve({ email: OWNER });
  });

  await withServer(client, async (origin) => {
    await signIn(origin);
    assert.equal(
      createHash("sha256").update(presented ?? "").digest("base64url"),
      client.authorize?.codeChallenge,
    );
  });
});

test("a completed sign-in authenticates later requests", async () => {
  await withServer(fakeClient(), async (origin) => {
    const session = await signIn(origin);
    assert.ok(session.startsWith("ncli_session="));

    const response = await fetch(`${origin}/api/session`, { headers: { cookie: session } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true,
      email: OWNER,
      clarityProjectId: null,
    });
  });
});

// Each refusal names its own cause: "start again" and "allow cookies" are
// different instructions, and one message for both helps nobody.
test("a mismatched state is refused", async () => {
  await withServer(fakeClient(), async (origin) => {
    assert.equal(await signIn(origin, () => "forged"), "400");
  });
});

test("a callback without the flow cookie says so", async () => {
  await withServer(fakeClient(), async (origin) => {
    const response = await fetch(`${origin}/.auth/login/aad/callback?code=abc&state=x`, {
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    assert.match(String((await response.json()).error), /No sign-in was in progress/);
  });
});

test("a rejected code exchange reports what Entra ID said", async () => {
  const client = fakeClient(() => Promise.reject(new Error("AADSTS7000218: the request body")));
  await withServer(client, async (origin) => {
    const start = await fetch(`${origin}/.auth/login/aad`, { redirect: "manual" });
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

    const callback = await fetch(`${origin}/.auth/login/aad/callback?code=abc&state=${state}`, {
      redirect: "manual",
      headers: { cookie: flowCookie },
    });
    assert.equal(callback.status, 502);
    const body = (await callback.json()) as { error: string; remedy?: string };
    assert.match(body.error, /AADSTS7000218/);
    // The one rejection with a fixed remedy says what that remedy is.
    assert.match(String(body.remedy), /public client/);
  });
});

test("a tampered session cookie is not a session", async () => {
  await withServer(fakeClient(), async (origin) => {
    const session = await signIn(origin);
    const [, value = ""] = session.split("=");
    const [payload = ""] = value.split(".");
    const forged = `ncli_session=${payload}.${"A".repeat(43)}`;

    const response = await fetch(`${origin}/`, {
      headers: { cookie: forged },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location") ?? "", /^\/\.auth\/login\/aad/);
  });
});

test("an external post-login target is replaced by the application root", async () => {
  await withServer(fakeClient(), async (origin) => {
    const start = await fetch(
      `${origin}/.auth/login/aad?post_login_redirect_uri=https://evil.example`,
      { redirect: "manual" },
    );
    const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await fetch(`${origin}/.auth/login/aad/callback?code=abc&state=${state}`, {
      redirect: "manual",
      headers: { cookie: flowCookie },
    });
    assert.equal(callback.headers.get("location"), "/");
  });
});

test("a token response without an address fails the sign-in", async () => {
  await withServer(fakeClient(() => Promise.resolve({})), async (origin) => {
    assert.equal(await signIn(origin), "502");
  });
});

test("the session endpoints report and clear the principal", async () => {
  await withServer(fakeClient(), async (origin) => {
    const session = await signIn(origin);

    const me = await fetch(`${origin}/.auth/me`, { headers: { cookie: session } });
    assert.deepEqual(await me.json(), {
      clientPrincipal: {
        identityProvider: "aad",
        userId: OWNER,
        userDetails: OWNER,
        userRoles: ["anonymous", "authenticated"],
      },
    });

    const anonymous = await fetch(`${origin}/.auth/me`);
    assert.deepEqual(await anonymous.json(), { clientPrincipal: null });

    const logout = await fetch(`${origin}/.auth/logout`, {
      headers: { cookie: session },
      redirect: "manual",
    });
    assert.equal(logout.status, 302);
    const cleared = logout.headers.getSetCookie()[0] ?? "";
    assert.equal(parseCookies(cleared.split(";")[0])["ncli_session"], "");
    assert.match(cleared, /Max-Age=0/);
  });
});