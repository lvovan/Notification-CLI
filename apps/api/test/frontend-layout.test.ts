import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const htmlPath = resolve("../web/index.html");
const mainPath = resolve("../web/src/main.ts");
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

test("the refresh control shares the heading row and its height", async () => {
  const [html, style] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);

  // The button must live inside the heading row to line up with the title.
  const heading =
    /<div class="section-heading">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(heading, /<h2 id="messages-title">/);
  assert.match(heading, /id="refresh-messages"/);
  assert.match(heading, /aria-label="[^"]+"/);

  // Both children are sized from one token, so the row cannot drift.
  assert.match(
    ruleBody(style, ".section-heading > \\*"),
    /height:\s*var\(--section-action-size\)/,
  );
  assert.match(
    ruleBody(style, ".icon-button"),
    /width:\s*var\(--section-action-size\)/,
  );
});

test("refreshing restarts paging from the newest notification", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /refreshMessages\.addEventListener\("click"/);
  assert.match(main, /reloadNotificationHistory/);
  // A reload must clear what is rendered and page in from the first page.
  assert.match(main, /displayedNotificationIds\.clear\(\)/);
  assert.match(main, /notificationHistoryCursor = undefined/);
  // Pages already in flight must not repopulate the refreshed list.
  assert.match(main, /notificationHistoryGeneration \+= 1/);
  assert.match(main, /generation !== notificationHistoryGeneration/);
});
