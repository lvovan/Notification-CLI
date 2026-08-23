import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

interface Route {
  route: string;
  methods?: string[];
  allowedRoles: string[];
  statusCode?: number;
}

test("SWA routes leave APIs to endpoint security and protect only the frontend", async () => {
  const config = JSON.parse(
    await readFile(
      resolve("../web/public/staticwebapp.config.json"),
      "utf8",
    ),
  ) as {
    platform: { apiRuntime: string };
    routes: Route[];
    navigationFallback: { exclude: string[] };
  };

  assert.equal(config.platform.apiRuntime, "node:22");

  const route = (path: string) =>
    config.routes.find((candidate) => candidate.route === path);

  assert.deepEqual(route("/api/*"), {
    route: "/api/*",
    allowedRoles: ["anonymous"],
  });
  assert.deepEqual(route("/*")?.allowedRoles, ["authenticated"]);

  const catchAllIndex = config.routes.findIndex(
    (candidate) => candidate.route === "/*",
  );
  assert.ok(
    config.routes.findIndex((candidate) => candidate.route === "/api/*") <
      catchAllIndex,
  );
});

test("OAuth discovery probes get a clean 404 instead of a sign-in redirect", async () => {
  const config = JSON.parse(
    await readFile(
      resolve("../web/public/staticwebapp.config.json"),
      "utf8",
    ),
  ) as {
    routes: Route[];
    navigationFallback: { exclude: string[] };
  };

  // MCP clients probe /.well-known/oauth-* before using static credentials.
  // Letting the authenticated catch-all answer redirects them to the Microsoft
  // sign-in page, whose HTML they cannot parse as a discovery document.
  assert.deepEqual(
    config.routes.find((candidate) => candidate.route === "/.well-known/*"),
    {
      route: "/.well-known/*",
      allowedRoles: ["anonymous"],
      statusCode: 404,
    },
  );
  assert.ok(
    config.routes.findIndex(
      (candidate) => candidate.route === "/.well-known/*",
    ) < config.routes.findIndex((candidate) => candidate.route === "/*"),
  );
  assert.ok(config.navigationFallback.exclude.includes("/.well-known/*"));
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
