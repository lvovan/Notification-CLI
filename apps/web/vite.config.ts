import { readFile, writeFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

const BUILD_ID_PLACEHOLDER = "__BUILD_ID__";

/**
 * The service worker is served verbatim from `public/`, so its bytes are
 * identical between deployments. Browsers compare the fetched worker byte for
 * byte and discard identical updates, which leaves installed apps - iOS home
 * screen apps in particular - pinned to the deployment they first installed.
 * Stamping a build id makes every deployment produce a different worker, which
 * is what actually triggers the update lifecycle.
 */
function stampServiceWorkerBuildId(): Plugin {
  const buildId = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, "")
    .slice(0, 14);

  return {
    name: "stamp-service-worker-build-id",
    async closeBundle() {
      const worker = new URL("./dist/service-worker.js", import.meta.url);
      const source = await readFile(worker, "utf8");
      if (!source.includes(BUILD_ID_PLACEHOLDER)) {
        throw new Error(
          `service-worker.js no longer contains ${BUILD_ID_PLACEHOLDER}; deployed apps would stop updating.`,
        );
      }
      await writeFile(
        worker,
        source.replaceAll(BUILD_ID_PLACEHOLDER, buildId),
        "utf8",
      );
    },
  };
}

export default defineConfig({
  plugins: [stampServiceWorkerBuildId()],
});
