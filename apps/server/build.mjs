import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    // The bundle is ESM but its dependencies reach for CommonJS globals.
    js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
});
