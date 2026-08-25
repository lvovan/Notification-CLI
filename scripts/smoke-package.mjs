import { access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const requiredFiles = [
  "dist/api/index.js",
  "dist/api/host.json",
  "dist/api/package.json",
  "dist/web/index.html",
  "dist/web/icon-192.png",
  "dist/web/icon-512.png",
  "dist/web/icon-maskable-512.png",
  "dist/web/apple-touch-icon.png",
  "dist/web/service-worker.js",
  "dist/web/staticwebapp.config.json",
  "dist/server/dist/main.js",
  "dist/server/package.json",
  "dist/server/web/index.html",
];

await Promise.all(requiredFiles.map((file) => access(file)));

const apiStartup = spawnSync(process.execPath, ["dist/api/index.js"], {
  encoding: "utf8",
  timeout: 15_000,
});
if (apiStartup.error || apiStartup.status !== 0) {
  throw new Error(
    `Packaged API failed to start: ${apiStartup.error?.message ?? apiStartup.stderr}`,
  );
}

await smokeServer();

console.log("Package smoke test passed");

/**
 * Starts the packaged App Service host and asks it for the OAuth metadata
 * MCP clients discover it by. That exercises the bundle, the routing table and
 * the static root in one request, without needing any Azure resource.
 */
async function smokeServer() {
  const port = 8791;
  const server = spawn(process.execPath, ["dist/main.js"], {
    cwd: "dist/server",
    env: {
      ...process.env,
      PORT: String(port),
      NOTIFICATION_CLI_ENTRA_TENANT_ID: "smoke",
      NOTIFICATION_CLI_ENTRA_CLIENT_ID: "smoke",
      NOTIFICATION_CLI_ENTRA_CLIENT_SECRET: "smoke",
      NOTIFICATION_CLI_SESSION_SECRET: "smoke-session-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  server.stderr.on("data", (chunk) => errors.push(String(chunk)));

  try {
    await Promise.race([
      once(server.stdout, "data"),
      once(server, "exit").then(() => {
        throw new Error(`Packaged server exited: ${errors.join("")}`);
      }),
    ]);

    const response = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
    );
    const metadata = await response.json();
    if (!response.ok || !metadata.resource) {
      throw new Error(`Unexpected OAuth metadata: ${JSON.stringify(metadata)}`);
    }
  } finally {
    server.kill();
  }
}
