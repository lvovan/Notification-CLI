import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";

const workerPath = repoPath("apps", "web", "public", "service-worker.js");
const mainPath = repoPath("apps", "web", "src", "main.ts");

test("the worker carries a build stamp so deployments are not byte-identical", async () => {
  const [worker, viteConfig] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(repoPath("apps", "web", "vite.config.ts"), "utf8"),
  ]);

  // A worker whose bytes never change is discarded by browsers as "no update",
  // which pins installed home screen apps to their original deployment.
  assert.match(worker, /const BUILD_ID = "__BUILD_ID__";/);
  assert.match(worker, /const CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{BUILD_ID\}`/);
  assert.ok(viteConfig.includes('"__BUILD_ID__"'));
  // The build must fail loudly rather than ship an unstamped worker.
  assert.match(viteConfig, /throw new Error\(/);
});

test("updates install automatically without waiting for a button", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /applyServiceWorkerUpdate/);
  assert.match(main, /postMessage\(\{ type: "SKIP_WAITING" \}\)/);
  assert.match(main, /updateViaCache: "none"/);
  // The manual "Update app" control must not come back: it left iOS home
  // screen apps stale until the user happened to notice it.
  assert.ok(!main.includes("Update app"));
  assert.ok(!main.includes("waitingWorker"));
  // controllerchange reloads into the newly activated worker.
  assert.match(main, /controllerchange/);
});

test("every plausible iOS resume signal triggers an update check", async () => {
  const main = await readFile(mainPath, "utf8");

  for (const trigger of ["pageshow", "focus", "visibilitychange", "online"]) {
    assert.match(
      main,
      new RegExp(`addEventListener\\("${trigger}"`),
      `missing update trigger for ${trigger}`,
    );
  }
  assert.match(main, /setInterval\(checkForUpdate, UPDATE_CHECK_INTERVAL_MS\)/);
  assert.match(main, /UPDATE_CHECK_THROTTLE_MS/);
});
