import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist");
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "api"), { recursive: true });

await Promise.all([
  cp(resolve("apps/web/dist"), resolve(output, "web"), { recursive: true }),
  cp(resolve("apps/api/dist/index.js"), resolve(output, "api/index.js")),
  cp(resolve("apps/api/host.json"), resolve(output, "api/host.json")),
]);

const packageJson = JSON.parse(
  await readFile(resolve("apps/api/package.deploy.json"), "utf8"),
);
await writeFile(
  resolve(output, "api/package.json"),
  `${JSON.stringify(packageJson, null, 2)}\n`,
);

console.log("Packaged Static Web App deployment artifacts in dist/");
