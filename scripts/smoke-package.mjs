import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

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
console.log("Package smoke test passed");
