import assert from "node:assert/strict";
import test, { before } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createNotificationServer } from "../src/server.js";
import { clientPrincipal, type SessionProvider } from "../src/session.js";

const OWNER = "user@example.com";

let webRoot: string;

before(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "notification-cli-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>shell</title>");
  await writeFile(join(webRoot, "app.a1b2c3.js"), "export default 1;");
  await writeFile(join(webRoot, "secret.txt"), "not served");
});

function session(email: string | null): SessionProvider {
  return { resolve: () => email, handle: () => false };
}

async function withServer(
  provider: SessionProvider,
  visit: (origin: string) => Promise<void>,
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

test("an API route reaches the shared handler with the resolved identity", async () => {
  await withServer(session(OWNER), async (origin) => {
    const response = await fetch(`${origin}/api/session`, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true,
      email: OWNER,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

test("a client principal from the wire is discarded rather than trusted", async () => {
  await withServer(session(null), async (origin) => {
    const response = await fetch(`${origin}/api/session`, {
      headers: { "x-ms-client-principal": clientPrincipal(OWNER) },
    });
    assert.equal(response.status, 401);
  });
});

test("an unknown endpoint is a 404 and a known one refuses the wrong method", async () => {
  await withServer(session(OWNER), async (origin) => {
    assert.equal((await fetch(`${origin}/api/nope`)).status, 404);
    const wrongMethod = await fetch(`${origin}/api/session`, { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");
  });
});

test("both methods of a shared path are mounted", async () => {
  await withServer(session(null), async (origin) => {
    // Unauthenticated, so both answer 401 rather than 404 or 405.
    assert.equal((await fetch(`${origin}/api/notifications`)).status, 401);
    assert.equal(
      (await fetch(`${origin}/api/notifications`, { method: "DELETE" })).status,
      401,
    );
  });
});

test("the application is gated behind sign-in", async () => {
  await withServer(session(null), async (origin) => {
    const response = await fetch(`${origin}/`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "/.auth/login/aad?post_login_redirect_uri=%2F",
    );
  });
});

test("a signed-in visitor gets the shell, revalidated on every load", async () => {
  await withServer(session(OWNER), async (origin) => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /shell/);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  });
});

test("hashed assets are cached forever and missing ones do not fall back", async () => {
  await withServer(session(OWNER), async (origin) => {
    const asset = await fetch(`${origin}/app.a1b2c3.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
  });
});

test("a deep link returns the application shell", async () => {
  await withServer(session(OWNER), async (origin) => {
    const response = await fetch(`${origin}/history/2026`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /shell/);
  });
});

test("a traversal cannot escape the web root", async () => {
  await withServer(session(OWNER), async (origin) => {
    const escaped = await fetch(`${origin}/..%2f..%2fpackage.json`);
    assert.equal(escaped.status, 404);
    const shell = await fetch(`${origin}/..%2f..%2fsecret`);
    assert.match(await shell.text(), /shell/);
  });
});

test("an unowned .auth path is a 404 rather than the application", async () => {
  await withServer(session(OWNER), async (origin) => {
    assert.equal((await fetch(`${origin}/.auth/unknown`)).status, 404);
  });
});
