import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";

const htmlPath = repoPath("apps", "web", "index.html");
const mainPath = repoPath("apps", "web", "src", "main.ts");
const stylePath = repoPath("apps", "web", "src", "style.css");
const helpPath = repoPath("apps", "web", "src", "push-help.ts");

function ruleBody(style: string, selector: string): string {
  const match = new RegExp(
    `(^|\\n)${selector.replace(/[.#:]/g, "\\$&")}\\s*(,\\s*[^{]+)?\\{([^}]*)\\}`,
  ).exec(style);
  assert.ok(match, `missing rule for ${selector}`);
  return match[3] ?? "";
}

test("the long wrapping unsupported string can never silently return", async () => {
  const [main, html] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);

  assert.doesNotMatch(main, /not supported by this browser/);
  assert.doesNotMatch(html, /not supported by this browser/);
});

test("the short label is exactly the non-wrapping text", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(
    main,
    /const PUSH_UNAVAILABLE_LABEL\s*=\s*"Notifications unavailable";/,
  );
});

test("all three unsupported call sites funnel through one helper", async () => {
  const main = await readFile(mainPath, "utf8");

  // One definition ...
  assert.match(main, /function setPushUnavailable\(\): void \{/);
  // ... and exactly three invocations, keeping the call sites consistent.
  const invocations = main.match(/(?<!function )setPushUnavailable\(\);/g) ?? [];
  assert.equal(invocations.length, 3);

  // The helper hides the bell toggle and builds an accessible dialog trigger.
  const start = main.indexOf("function setPushUnavailable(): void {");
  const end = main.indexOf("\n}", start);
  const body = main.slice(start, end);
  assert.match(body, /toggleNotifications\.hidden = true/);
  assert.match(body, /aria-haspopup/);
  assert.match(body, /"dialog"/);
  assert.match(body, /pushStatus\.replaceChildren\(trigger\)/);
});

test("the trigger reads as red status text but never wraps", async () => {
  const style = await readFile(stylePath, "utf8");
  const trigger = ruleBody(style, ".push-help-trigger");

  assert.match(trigger, /color:\s*var\(--cp-danger\)/);
  assert.match(trigger, /white-space:\s*nowrap/);
  assert.match(trigger, /cursor:\s*pointer/);
  assert.match(trigger, /appearance:\s*none/);
});

test("the status line keeps its live-region semantics in the markup", async () => {
  const html = await readFile(htmlPath, "utf8");
  const status =
    /<p\s+[^>]*id="push-status"[\s\S]*?><\/p>/.exec(html)?.[0] ?? "";

  assert.ok(status, "missing push-status paragraph");
  assert.match(status, /role="status"/);
  assert.match(status, /aria-live="polite"/);
});

test("a native <dialog> holds the help content and a close control", async () => {
  const html = await readFile(htmlPath, "utf8");
  const dialog =
    /<dialog[\s\S]*?id="push-help-dialog"[\s\S]*?<\/dialog>/.exec(html)?.[0] ??
    "";

  assert.ok(dialog, "missing push help dialog");
  assert.match(dialog, /aria-labelledby="push-help-title"/);
  assert.match(dialog, /id="push-help-title"/);
  assert.match(dialog, /id="push-help-steps"/);
  assert.match(dialog, /id="push-help-close"/);
  // No inline styles are allowed under the CSP.
  assert.doesNotMatch(dialog, /style=/);
});

test("the dialog opens modally with a graceful fallback and full dismissal", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /pushHelpGuidance\(/);
  assert.match(main, /typeof pushHelpDialog\.showModal === "function"/);
  assert.match(main, /pushHelpDialog\.showModal\(\)/);
  assert.match(main, /push-help-dialog--fallback-open/);
  // Close button, Escape (cancel + fallback keydown) and backdrop click.
  assert.match(main, /pushHelpClose\.addEventListener\("click", closePushHelp\)/);
  assert.match(main, /addEventListener\("cancel"/);
  assert.match(main, /event\.target === pushHelpDialog/);
  assert.match(main, /event\.key === "Escape"/);
});

test("the guidance module is self-contained and Node-testable", async () => {
  const help = await readFile(helpPath, "utf8");

  // No imports/requires: the module is self-contained, so the other tests can
  // (and do) exercise pushHelpGuidance directly under Node without any DOM.
  assert.doesNotMatch(help, /^\s*import\s/m);
  assert.doesNotMatch(help, /\brequire\(/);
  assert.match(help, /export function pushHelpGuidance\(/);
  assert.match(help, /export interface PushHelpEnvironment /);
  assert.match(help, /export interface PushHelpGuidance /);
});
