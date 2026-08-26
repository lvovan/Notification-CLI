import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";
import { CLARITY_EVENTS, CLARITY_TAGS } from "@notification-cli/core/telemetry";

const mainPath = repoPath("apps", "web", "src", "main.ts");
const telemetryPath = repoPath("apps", "web", "src", "telemetry.ts");
const htmlPath = repoPath("apps", "web", "index.html");

test("the analytics tag loads as an external script, never inline", async () => {
  const source = await readFile(telemetryPath, "utf8");

  // An inline snippet would force 'unsafe-inline' into script-src, undoing the
  // hash-pinned policy the rest of the page depends on.
  assert.match(source, /createElement\("script"\)/);
  assert.match(source, /https:\/\/www\.clarity\.ms\/tag\//);
  assert.doesNotMatch(source, /innerHTML|document\.write/);
});

test("the account address is pseudonymised before it reaches analytics", async () => {
  const source = await readFile(telemetryPath, "utf8");

  assert.match(source, /crypto\.subtle\.digest\(\s*"SHA-256"/);
  // `identify` must only ever receive the digest, never the address itself.
  assert.doesNotMatch(source, /clarity\("identify", *(options\.)?email/);
});

test("regions that can contain personal content are masked from replays", async () => {
  const html = await readFile(htmlPath, "utf8");

  for (const id of ["message-list", "account-email"]) {
    const element = new RegExp(`id="${id}"[^>]*data-clarity-mask="true"`).exec(html);
    assert.ok(element, `${id} must be masked in session recordings`);
  }
});

test("the project id is handed to the bundle through the DOM", async () => {
  const html = await readFile(htmlPath, "utf8");
  const main = await readFile(mainPath, "utf8");

  // Delivered on the existing session response rather than a second request.
  assert.match(html, /dataset\.telemetryProject\s*=/);
  assert.match(html, /session\.clarityProjectId/);
  assert.match(main, /dataset\.telemetryProject/);
  assert.match(main, /startTelemetry\(/);
});

test("every declared tag and event is actually emitted by the frontend", async () => {
  const main = await readFile(mainPath, "utf8");
  const telemetry = await readFile(telemetryPath, "utf8");
  const source = `${main}\n${telemetry}`;

  for (const name of Object.keys(CLARITY_TAGS)) {
    assert.match(
      source,
      new RegExp(`CLARITY_TAGS\\.${name}\\b`),
      `the ${name} tag is declared but never set`,
    );
  }
  for (const name of Object.keys(CLARITY_EVENTS)) {
    assert.match(
      source,
      new RegExp(`CLARITY_EVENTS\\.${name}\\b`),
      `the ${name} event is declared but never tracked`,
    );
  }
});

test("the test button declares itself as the web source", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /NOTIFICATION_SOURCE_HEADER/);
  assert.match(main, /"web"/);
});
