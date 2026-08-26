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

test("the status dot is a named button with the test-message tooltip", async () => {
  const html = await readFile(htmlPath, "utf8");
  const dot =
    /<button\s+[^>]*id="status-dot"[\s\S]*?<\/button>/.exec(html)?.[0] ??
    "";

  assert.ok(dot, "missing status dot button");
  assert.match(dot, /\btype="button"/);
  assert.match(dot, /\bclass="status-dot"/);
  assert.match(dot, /\btitle="Click to send a test message"/);
  assert.match(dot, /\baria-label="[^"]+"/);
  assert.doesNotMatch(html, /<span\s+[^>]*id="status-dot"/);
});

test("the button status dot keeps the old span geometry and alignment", async () => {
  const style = await readFile(stylePath, "utf8");
  const dot = ruleBody(style, ".status-dot");

  assert.match(dot, /position:\s*relative/);
  assert.match(dot, /align-self:\s*start/);
  assert.match(dot, /width:\s*var\(--status-dot-size\)/);
  assert.match(dot, /height:\s*var\(--status-dot-size\)/);
  assert.match(dot, /padding:\s*0/);
  assert.match(dot, /border:\s*0/);
  assert.match(dot, /appearance:\s*none/);
  assert.match(dot, /margin-top:\s*calc\(\(1lh - var\(--status-dot-size\)\) \/ 2\)/);
});

test("the tiny status dot grows only its transparent tap target", async () => {
  const style = await readFile(stylePath, "utf8");
  const target = ruleBody(style, ".status-dot::after");

  // The visible dot stays aligned with the text, while the pseudo-element
  // makes the phone tap target roughly 44px without drawing a larger dot.
  assert.match(target, /content:\s*""/);
  assert.match(target, /position:\s*absolute/);
  assert.match(
    target,
    /inset:\s*calc\(\(44px - var\(--status-dot-size\)\) \/ -2\)\s+calc\(\(41px - var\(--status-dot-size\)\) \/ -2\)\s+calc\(\(44px - var\(--status-dot-size\)\) \/ -2\)\s+calc\(\(47px - var\(--status-dot-size\)\) \/ -2\)/,
  );
  assert.match(target, /border-radius:\s*50%/);
});

test("the status dot has a deliberate focus-visible ring", async () => {
  const style = await readFile(stylePath, "utf8");

  assert.match(
    ruleBody(style, ".status-dot:focus-visible"),
    /box-shadow:\s*0 0 0 5px var\(--cp-accent\)/,
  );
});

test("clicking the status dot posts a real test notification with the api key", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /statusDot\.addEventListener\("click"/);
  assert.match(main, /sendTestNotification/);
  assert.match(main, /fetch\("\/api\/notify"/);
  assert.match(main, /method:\s*"POST"/);
  assert.match(main, /"x-api-key":\s*apiKey/);
  assert.match(main, /body:\s*JSON\.stringify\(\{\s*message:\s*TEST_NOTIFICATION_MESSAGE\s*\}\)/);
});

test("test sends are guarded by a busy flag without disabling the dot", async () => {
  const main = await readFile(mainPath, "utf8");
  const start = main.indexOf("async function sendTestNotification()");
  const end = main.indexOf("function disarmCycle()", start);
  const sender = start >= 0 && end > start ? main.slice(start, end) : "";

  assert.ok(sender, "missing sendTestNotification");
  assert.match(sender, /if \(testNotificationBusy\)/);
  assert.match(sender, /testNotificationBusy = true/);
  assert.match(sender, /testNotificationBusy = false/);
  assert.doesNotMatch(sender, /\.disabled\b/);
  assert.doesNotMatch(sender, /setAttribute\("disabled"/);
  assert.doesNotMatch(sender, /false,\s*false/);
});

test("transient test feedback only clears if no newer status replaced it", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /const TEST_NOTIFICATION_SUCCESS\s*=/);
  assert.match(
    main,
    /if \(messagesStatus\.textContent === TEST_NOTIFICATION_SUCCESS\) \{\s*setHistoryStatus\(lastRetentionDays\);/,
  );
  assert.match(main, /This line is shared with history loading/);
  assert.doesNotMatch(main, /DocumentFragment/);
  assert.doesNotMatch(main, /testNotificationPreviousStatus/);
  assert.doesNotMatch(main, /preserveMessagesStatusBeforeTestFeedback/);
});

test("sign-in checks no longer depend on the removed authorization contract", async () => {
  const [html, main] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  assert.doesNotMatch(html, /session\.authorized/);
  assert.match(html, /if \(response\.ok\)/);
  assert.doesNotMatch(html, /Account not authorized/);
  assert.doesNotMatch(html, /authorized Microsoft account/);
  assert.doesNotMatch(main, /status === 403/);
  assert.doesNotMatch(main, /401\s*\|\|\s*error\.status\s*===\s*403/);
});
