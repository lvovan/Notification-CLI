import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "api"), { recursive: true });
await mkdir(resolve(output, "server/dist"), { recursive: true });

await Promise.all([
  cp(resolve("apps/web/dist"), resolve(output, "web"), { recursive: true }),
  cp(resolve("apps/api/dist/index.js"), resolve(output, "api/index.js")),
  cp(resolve("apps/api/host.json"), resolve(output, "api/host.json")),
  // The App Service host serves the same frontend itself, so it ships with a
  // copy of it next to the bundle, exactly where main.js expects to find it.
  cp(resolve("apps/web/dist"), resolve(output, "server/web"), { recursive: true }),
  cp(resolve("apps/server/dist/main.js"), resolve(output, "server/dist/main.js")),
]);

const packageJson = JSON.parse(
  await readFile(resolve("apps/api/package.deploy.json"), "utf8"),
);
await writeFile(
  resolve(output, "api/package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
);

// `type` keeps Node from parsing the ESM bundle as CommonJS. `main` and
// `start` are what let App Service work out how to run it: with neither, the
// platform finds no entry point it recognises and keeps serving its own
// welcome page, which looks exactly like a failed deployment.
await writeFile(
  resolve(output, "server/package.json"),
  `${JSON.stringify(
    {
      name: "notification-cli-server",
      private: true,
      type: "module",
      main: "dist/main.js",
      scripts: { start: "node dist/main.js" },
    },
    null,
    2,
  )}\n`,
);

console.log("Packaged Static Web App and App Service artifacts in dist/");
