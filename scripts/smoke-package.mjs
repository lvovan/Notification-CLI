import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

const requiredFiles = [
  "dist/server/dist/main.js",
  "dist/server/package.json",
  "dist/server/web/index.html",
  "dist/server/web/icon-192.png",
  "dist/server/web/icon-512.png",
  "dist/server/web/icon-maskable-512.png",
  "dist/server/web/apple-touch-icon.png",
  "dist/server/web/manifest.webmanifest",
  "dist/server/web/service-worker.js",
];

await Promise.all(requiredFiles.map((file) => access(file)));
await Promise.all(
  ["api", "web"].map(async (name) => {
    const file = `dist/${name}`;
    try {
      await access(file);
    } catch {
      return;
    }
    throw new Error(`${file} is obsolete and must not be packaged`);
  }),
);

// App Service runs `npm start`. Without it the package deploys cleanly and
// then serves the platform's welcome page instead of the application.
const serverManifest = JSON.parse(
  await readFile("dist/server/package.json", "utf8"),
);
if (serverManifest.scripts?.start !== "node dist/main.js") {
  throw new Error("Packaged server has no start script for App Service");
}
if (serverManifest.type !== "module" || serverManifest.main !== "dist/main.js") {
  throw new Error("Packaged server manifest does not point at the ESM entrypoint");
}

await smokeServer();

console.log("Package smoke test passed");

/**
 * A fixed port makes the smoke test fail on any machine that already has
 * something listening on it, which says nothing about the package.
 */
async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the packaged App Service host and checks the frontend gate plus OAuth
 * metadata. File assertions above prove the static web root is bundled without
 * needing a live Entra sign-in.
 */
async function smokeServer() {
  const port = await freePort();
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

    const frontend = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
    });
    if (
      frontend.status !== 302 ||
      frontend.headers.get("location") !==
        "/.auth/login/aad?post_login_redirect_uri=%2F"
    ) {
      throw new Error("Packaged server did not gate the web frontend");
    }

    const worker = await fetch(`http://127.0.0.1:${port}/service-worker.js`, {
      redirect: "manual",
    });
    if (worker.status !== 302) {
      throw new Error("Packaged server did not gate the service worker");
    }

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
