import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const mainPath = resolve("../web/src/main.ts");
const htmlPath = resolve("../web/index.html");
const stylePath = resolve("../web/src/style.css");

test("notification history loads five items at a time with an opaque cursor", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /NOTIFICATION_HISTORY_PAGE_SIZE = 5/);
  assert.match(main, /limit: String\(NOTIFICATION_HISTORY_PAGE_SIZE\)/);
  assert.match(main, /before: cursor/);
  assert.match(main, /nextCursor/);
  assert.doesNotMatch(main, /nextCursor\.(split|slice|substring|match)/);
});

test("notification paging uses an observer that stops at the end", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /new IntersectionObserver/);
  assert.match(main, /observe\(messageListSentinel\)/);
  assert.match(main, /disconnect\(\)/);
  assert.match(main, /notificationHistoryCursor === null/);
});

test("notification paging guards duplicate loads and keeps failures retryable", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /notificationHistoryLoading = true/);
  assert.match(
    main,
    /notificationHistoryLoading \|\| notificationHistoryCursor === null/,
  );
  assert.match(main, /Loading earlier notifications/);
  assert.match(main, /retry-notification-history/);
});

test("the clear notification control is not rendered or wired", async () => {
  const [main, html, style] = await Promise.all([
    readFile(mainPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(stylePath, "utf8"),
  ]);

  assert.ok(!html.includes('id="clear"'));
  assert.ok(!html.includes("quiet-button"));
  assert.ok(!main.includes("clearButton"));
  assert.ok(!style.includes(".quiet-button"));
});

test("the account email shares the connection panel's secondary style", async () => {
  const html = await readFile(htmlPath, "utf8");

  // It sits between the connection state and the notification state, styled
  // like the latter rather than as its own header treatment.
  const statusText =
    /<div class="status-text">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const order = ['id="status"', 'id="account-email"', 'id="push-status"'].map(
    (marker) => statusText.indexOf(marker),
  );
  assert.ok(
    order.every((index) => index >= 0),
    "the connection panel is missing one of its lines",
  );
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(statusText, /class="push-status" id="account-email"/);
});
