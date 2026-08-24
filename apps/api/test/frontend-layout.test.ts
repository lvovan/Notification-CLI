import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const htmlPath = resolve("../web/index.html");
const mainPath = resolve("../web/src/main.ts");
const stylePath = resolve("../web/src/style.css");

function ruleBody(style: string, selector: string): string {
  const match = new RegExp(
    `(^|\\n)${selector.replace(/[.#]/g, "\\$&")}\\s*(,\\s*[^{]+)?\\{([^}]*)\\}`,
  ).exec(style);
  assert.ok(match, `missing rule for ${selector}`);
  return match[3] ?? "";
}

test("the logo and the title block share one height token", async () => {
  const style = await readFile(stylePath, "utf8");

  // Both must read the same variable, otherwise the header stops lining up.
  assert.match(ruleBody(style, ".mark"), /height:\s*var\(--header-mark-size\)/);
  assert.match(ruleBody(style, ".brand"), /height:\s*var\(--header-mark-size\)/);
  assert.match(
    ruleBody(style, ".account"),
    /height:\s*var\(--header-mark-size\)/,
  );
});

test("the three top panels share one vertical gap", async () => {
  const style = await readFile(stylePath, "utf8");

  // The offset below each panel and the gap between tiles must stay identical.
  assert.match(
    ruleBody(style, ".metrics-card"),
    /margin-top:\s*var\(--metrics-gap\)/,
  );
  assert.match(
    ruleBody(style, ".apikey-card"),
    /margin-top:\s*var\(--metrics-gap\)/,
  );
  assert.match(ruleBody(style, ".metrics"), /gap:\s*var\(--metrics-gap\)/);

  // An empty status line must not silently widen the gap below its card.
  assert.match(style, /#metrics-status:not\(:empty\)/);
});

test("the status dot lines up with the first line of the status text", async () => {
  const style = await readFile(stylePath, "utf8");

  // Centring the dot on the whole text block would drop it below the label.
  const dot = ruleBody(style, ".status-dot");
  assert.match(dot, /align-self:\s*start/);
  assert.match(dot, /margin-top:\s*calc\(\(1lh - var\(--status-dot-size\)\) \/ 2\)/);
});

test("the metrics heading is gone and the list is named Notifications", async () => {
  const html = await readFile(htmlPath, "utf8");

  assert.ok(!html.includes('id="metrics-title"'));
  assert.match(html, /<section class="metrics-card" aria-label="[^"]+"/);
  assert.match(html, /<h2 id="messages-title">[\s\S]*?Notifications[\s\S]*?<\/h2>/);
});

test("the notifications heading doubles as the refresh control", async () => {
  const [html, style] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);

  // The trigger is the heading itself, so there is no separate icon button.
  const heading =
    /<div class="section-heading">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(
    heading,
    /<h2 id="messages-title">\s*<button id="refresh-messages" class="heading-button"/,
  );
  assert.ok(!style.includes(".icon-button"));

  // Underlined only: color, font and size stay inherited from the heading.
  const button = ruleBody(style, ".heading-button");
  assert.match(button, /font:\s*inherit/);
  assert.match(button, /color:\s*inherit/);
  assert.match(button, /text-decoration:\s*underline/);
  assert.ok(!/font-size:/.test(button));
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
