import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

interface Route {
  route: string;
  methods?: string[];
  allowedRoles: string[];
}

test("SWA routes protect browser APIs and preserve key-protected senders", async () => {
  const config = JSON.parse(
    await readFile(
      resolve("../web/public/staticwebapp.config.json"),
      "utf8",
    ),
  ) as {
    platform: { apiRuntime: string };
    routes: Route[];
  };

  assert.equal(config.platform.apiRuntime, "node:22");

  const route = (path: string) =>
    config.routes.find((candidate) => candidate.route === path);

  assert.deepEqual(route("/api/mcp"), {
    route: "/api/mcp",
    methods: ["POST"],
    allowedRoles: ["anonymous"],
  });

  assert.deepEqual(route("/api/notify"), {
    route: "/api/notify",
    methods: ["POST"],
    allowedRoles: ["anonymous"],
  });
  assert.deepEqual(route("/api/negotiate")?.allowedRoles, ["authenticated"]);
  assert.deepEqual(route("/api/session")?.allowedRoles, ["authenticated"]);
  assert.deepEqual(route("/*")?.allowedRoles, ["authenticated"]);

  const catchAllIndex = config.routes.findIndex(
    (candidate) => candidate.route === "/*",
  );
  assert.ok(
    config.routes.findIndex((candidate) => candidate.route === "/api/notify") <
      catchAllIndex,
  );
});

test("CSP permits the mandatory inline theme bootstrap by hash", async () => {
  const [configText, html] = await Promise.all([
    readFile(resolve("../web/public/staticwebapp.config.json"), "utf8"),
    readFile(resolve("../web/index.html"), "utf8"),
  ]);
  const config = JSON.parse(configText) as {
    globalHeaders: { "Content-Security-Policy": string };
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const hash = createHash("sha256")
    .update(script.replaceAll("\r\n", "\n"))
    .digest("base64");
  assert.match(
    config.globalHeaders["Content-Security-Policy"],
    new RegExp(`script-src[^;]*'sha256-${hash}'`),
  );
});
