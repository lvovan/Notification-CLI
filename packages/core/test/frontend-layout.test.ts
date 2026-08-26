import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";

const htmlPath = repoPath("apps", "web", "index.html");
const mainPath = repoPath("apps", "web", "src", "main.ts");
const stylePath = repoPath("apps", "web", "src", "style.css");

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

test("the notifications heading carries a right-aligned delete control", async () => {
  const [html, style, main] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  const heading =
    /<div class="section-heading">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const trashPath =
    /id="clear-messages"[\s\S]*?<path d="([^"]+)"><\/path>/.exec(
      heading,
    )?.[1] ?? "";
  const mainTrashPath =
    /const TRASH_ICON_PATH =\s*\r?\n\s*"([^"]+)";/.exec(main)?.[1] ?? "";
  assert.match(heading, /id="clear-messages"/);
  assert.match(heading, /class="heading-action"/);
  assert.match(heading, /aria-label="Delete all notifications"/);
  assert.match(
    heading,
    /<svg class="heading-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/,
  );
  assert.ok(
    !heading.includes("\u{1F5D1}"),
    "delete icon must not use emoji metrics",
  );
  assert.ok(trashPath, "missing inline trash path");
  assert.equal(trashPath, mainTrashPath);
  // The heading comes first and the row spreads them apart, which is what puts
  // the control on the right without any extra positioning.
  assert.ok(
    heading.indexOf("messages-title") < heading.indexOf("clear-messages"),
  );
  assert.match(
    ruleBody(style, ".section-heading"),
    /justify-content:\s*space-between/,
  );
});

test("deleting every notification needs a confirmation and keeps the counts", async () => {
  const main = await readFile(mainPath, "utf8");

  // First click arms, second click deletes; the same two-step used for the key.
  assert.match(main, /clearMessages\.addEventListener\("click"/);
  assert.match(main, /clearMessages\.dataset\.armed === "true"/);
  assert.match(main, /armClear\(\)/);
  assert.match(main, /disarmClear\(\)/);

  // Deletion is a DELETE on the history endpoint; nothing touches the metrics.
  const clear =
    /async function clearNotificationHistory\(\)[\s\S]*?\r?\n\}\r?\n/.exec(
      main,
    )?.[0] ?? "";
  assert.ok(clear, "missing clearNotificationHistory");
  assert.match(clear, /"\/api\/notifications"/);
  assert.match(clear, /method: "DELETE"/);
  assert.ok(
    !clear.includes("refreshMetrics"),
    "clearing must not reset the metrics",
  );
});

test("an equally sized cancel button sits beside the delete confirmation", async () => {
  const [html, style, main] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  const actions =
    /<div class="heading-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.ok(actions, "missing heading-actions row");
  // Same class, so the square sizing is shared rather than duplicated, and the
  // cancel control follows the delete one.
  assert.match(actions, /id="cancel-clear"[\s\S]*?class="heading-action"/);
  assert.match(
    actions,
    /id="cancel-clear"[\s\S]*?<svg class="heading-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/,
  );
  assert.ok(!actions.includes("\u2715"), "cancel icon must not use glyph metrics");
  assert.ok(actions.indexOf("clear-messages") < actions.indexOf("cancel-clear"));
  assert.match(actions, /id="cancel-clear"[\s\S]*?hidden/);

  // The shared class sets `display: grid`, which would otherwise win over the
  // hidden attribute and leave the cancel button on screen.
  assert.match(style, /\.heading-action\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(ruleBody(style, ".heading-action"), /box-sizing:\s*border-box/);
  assert.match(ruleBody(style, ".heading-action"), /padding:\s*0/);
  assert.match(
    style,
    /\.heading-action\[data-armed="true"\]\s*\{[\s\S]*?padding:\s*0 0\.7rem/,
  );
  assert.match(ruleBody(style, ".heading-action-icon"), /display:\s*block/);
  assert.match(ruleBody(style, ".heading-action-icon"), /width:\s*1\.05em/);
  assert.match(ruleBody(style, ".heading-action-icon"), /height:\s*1\.05em/);
  assert.match(ruleBody(style, ".heading-action-icon"), /fill:\s*currentColor/);

  // Visible only while the delete is armed, and cancelling never deletes.
  assert.match(main, /clearMessages\.replaceChildren\(createTrashIcon\(\)\)/);
  assert.ok(!main.includes('clearMessages.textContent = "🗑️"'));
  assert.match(main, /clearMessages\.textContent = "Confirm"/);
  assert.deepEqual(
    main.match(/clearMessages\.textContent = /g),
    ["clearMessages.textContent = "],
  );
  assert.ok(!main.includes("cancelClear.textContent"));
  assert.match(main, /cancelClear\.hidden = false/);
  assert.match(main, /cancelClear\.hidden = true/);
  assert.match(main, /cancelClear\.addEventListener\("click", disarmClear\)/);
});
