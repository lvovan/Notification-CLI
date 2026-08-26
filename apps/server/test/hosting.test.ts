import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { createNotificationServer } from "../src/server.js";
import { GLOBAL_HEADERS } from "../src/response.js";
import type { SessionProvider } from "../src/session.js";

function session(email: string | null, onResolve?: () => void): SessionProvider {
  return {
    resolve: () => {
      onResolve?.();
      return email;
    },
    handle: () => false,
  };
}

async function withServer(
  provider: SessionProvider,
  visit: (origin: string) => Promise<void>,
  webRoot = resolve("../web"),
): Promise<void> {
  const server = createNotificationServer({
    webRoot,
    session: provider,
    logger: { error: () => {} },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  try {
    await visit(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

test("App Service leaves endpoint prefixes to API security and gates only the frontend", async () => {
  await withServer(session(null), async (origin) => {
    const api = await fetch(`${origin}/api/session`, { redirect: "manual" });
    assert.equal(api.status, 401);

    const oauth = await fetch(`${origin}/oauth/jwks`, { redirect: "manual" });
    assert.equal(oauth.status, 503);

    const wellKnown = await fetch(`${origin}/.well-known/openid-configuration`, {
      redirect: "manual",
    });
    assert.equal(wellKnown.status, 200);

    const application = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(application.status, 302);
    assert.equal(
      application.headers.get("location"),
      "/.auth/login/aad?post_login_redirect_uri=%2F",
    );
  });
});

test("OAuth discovery probes are served without the sign-in gate", async () => {
  let resolved = 0;
  await withServer(session(null, () => resolved += 1), async (origin) => {
    // MCP clients probe before presenting credentials; a sign-in HTML redirect
    // is not a parseable discovery document.
    const resource = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      redirect: "manual",
    });
    assert.equal(resource.status, 200);
    assert.match((await resource.json()).resource, /\/api\/mcp$/);

    const unknown = await fetch(`${origin}/.well-known/oauth-unknown`, {
      redirect: "manual",
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "Unknown endpoint." });
  });
  assert.equal(resolved, 0);
});

test("CSP permits the mandatory inline theme bootstrap by hash", async () => {
  const html = await readFile(resolve("../web/index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const hash = createHash("sha256")
    .update(script.replaceAll("\r\n", "\n"))
    .digest("base64");
  const csp = GLOBAL_HEADERS["Content-Security-Policy"];
  assert.ok(csp);
  assert.match(
    csp,
    new RegExp(`script-src[^;]*'sha256-${hash}'`),
  );
});

test("the shell and worker are never served from a stale HTTP cache", async () => {
  await withServer(session(null), async (origin) => {
    for (const path of ["/", "/index.html", "/service-worker.js"]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      assert.equal(response.status, 302, `${path} must stay behind sign-in`);
    }
  }, resolve("../web/public"));

  await withServer(session("user@example.com"), async (origin) => {
    for (const path of ["/", "/index.html"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "no-cache",
        `${path} must be revalidated by the browser`,
      );
    }
  });

  await withServer(session("user@example.com"), async (origin) => {
    const response = await fetch(`${origin}/service-worker.js`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "no-cache",
      "/service-worker.js must be revalidated by the browser",
    );
  }, resolve("../web/public"));
});
