import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const htmlPath = resolve("../web/index.html");
const stylePath = resolve("../web/src/style.css");

function ruleBody(style: string, selector: string): string {
  const match = new RegExp(
    `(^|\\n)${selector.replace(/[.#]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  ).exec(style);
  assert.ok(match, `missing rule for ${selector}`);
  return match[2] ?? "";
}

test("the logo and the account block share one height token", async () => {
  const style = await readFile(stylePath, "utf8");

  // Both must read the same variable, otherwise the header stops lining up.
  assert.match(ruleBody(style, ".mark"), /height:\s*var\(--header-mark-size\)/);
  assert.match(
    ruleBody(style, ".account"),
    /height:\s*var\(--header-mark-size\)/,
  );
  assert.match(
    ruleBody(style, ".account"),
    /justify-content:\s*space-between/,
  );
});

test("metrics sit one gap below the status card", async () => {
  const style = await readFile(stylePath, "utf8");

  // The vertical offset and the gap between tiles must stay identical.
  assert.match(
    ruleBody(style, ".metrics-card"),
    /margin-top:\s*var\(--metrics-gap\)/,
  );
  assert.match(ruleBody(style, ".metrics"), /gap:\s*var\(--metrics-gap\)/);
});

test("the metrics heading is gone and the list is named Notifications", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.ok(!html.includes('id="metrics-title"'));
  assert.match(html, /<section class="metrics-card" aria-label="[^"]+"/);
  assert.match(html, /<h2 id="messages-title">Notifications<\/h2>/);
});
