import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ConfigurationError } from "@notification-cli/core/configuration";
import {
  createEntraSessionProvider,
  parseCookies,
  readEntraConfig,
  type EntraConfig,
  type TokenExchange,
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

function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const exchangeOk: TokenExchange = () =>
  Promise.resolve({ id_token: idToken({ preferred_username: OWNER.toUpperCase() }) });

async function withServer(
  exchange: TokenExchange,
  visit: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createNotificationServer({
    webRoot: process.cwd(),
    session: createEntraSessionProvider(CONFIG, exchange),
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
async function signIn(origin: string, exchangeState?: (state: string) => string): Promise<string> {
  const start = await fetch(`${origin}/.auth/login/aad?post_login_redirect_uri=/history`, {
    redirect: "manual",
  });
  const authorize = new URL(start.headers.get("location") ?? "");
  const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const state = authorize.searchParams.get("state") ?? "";

  const callback = await fetch(
    `${origin}/.auth/login/aad/callback?code=abc&state=${encodeURIComponent(
      exchangeState ? exchangeState(state) : state,
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
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
});

test("sign-in starts a PKCE code flow bound to a sealed cookie", async () => {
  await withServer(exchangeOk, async (origin) => {
    const response = await fetch(`${origin}/.auth/login/aad?post_login_redirect_uri=/history`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);

    const authorize = new URL(response.headers.get("location") ?? "");
    assert.equal(authorize.origin, "https://login.microsoftonline.com");
    assert.equal(authorize.pathname, "/tenant/oauth2/v2.0/authorize");
    assert.equal(authorize.searchParams.get("client_id"), "client");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorize.searchParams.get("code_challenge"));
    assert.match(
      authorize.searchParams.get("redirect_uri") ?? "",
      /^https:\/\/127\.0\.0\.1:\d+\/\.auth\/login\/aad\/callback$/,
    );

    const [flow] = response.headers.getSetCookie();
    assert.ok(flow?.startsWith("ncli_flow="));
    assert.match(flow ?? "", /HttpOnly/);
    assert.match(flow ?? "", /SameSite=Lax/);
  });
});

test("the code challenge is the S256 hash of the verifier that is later presented", async () => {
  let presented: URLSearchParams | undefined;
  await withServer(
    (_config, body) => {
      presented = body;
      return Promise.resolve({ id_token: idToken({ email: OWNER }) });
    },
    async (origin) => {
      const start = await fetch(`${origin}/.auth/login/aad`, { redirect: "manual" });
      const challenge = new URL(start.headers.get("location") ?? "").searchParams.get(
        "code_challenge",
      );
      const flowCookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

      await fetch(`${origin}/.auth/login/aad/callback?code=abc&state=${state}`, {
        redirect: "manual",
        headers: { cookie: flowCookie },
      });

      const verifier = presented?.get("code_verifier") ?? "";
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
      assert.equal(presented?.get("grant_type"), "authorization_code");
      assert.equal(presented?.get("client_secret"), "secret");
    },
  );
});

test("a completed sign-in authenticates later requests", async () => {
  process.env.AUTHORIZED_USERS = OWNER;
  try {
    await withServer(exchangeOk, async (origin) => {
      const session = await signIn(origin);
      assert.ok(session.startsWith("ncli_session="));

      const response = await fetch(`${origin}/api/session`, { headers: { cookie: session } });
      assert.equal(response.status, 200);
      // The address is normalized, so the allowlist comparison is exact.
      assert.deepEqual(await response.json(), {
        authenticated: true,
        authorized: true,
        email: OWNER,
      });
    });
  } finally {
    delete process.env.AUTHORIZED_USERS;
  }
});

test("a mismatched state is refused", async () => {
  await withServer(exchangeOk, async (origin) => {
    assert.equal(await signIn(origin, () => "forged"), "400");
  });
});

test("a callback without the flow cookie is refused", async () => {
  await withServer(exchangeOk, async (origin) => {
    const response = await fetch(`${origin}/.auth/login/aad/callback?code=abc&state=x`, {
      redirect: "manual",
    });
    assert.equal(response.status, 400);
  });
});

test("a tampered session cookie is not a session", async () => {
  await withServer(exchangeOk, async (origin) => {
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
  await withServer(exchangeOk, async (origin) => {
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
  await withServer(() => Promise.resolve({}), async (origin) => {
    assert.equal(await signIn(origin), "502");
  });
});

test("the session endpoints report and clear the principal", async () => {
  await withServer(exchangeOk, async (origin) => {
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
