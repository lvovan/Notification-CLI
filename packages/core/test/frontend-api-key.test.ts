import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";

const htmlPath = repoPath("apps", "web", "index.html");
const mainPath = repoPath("apps", "web", "src", "main.ts");
const stylePath = repoPath("apps", "web", "src", "style.css");
const workerPath = repoPath("apps", "web", "public", "service-worker.js");

function ruleBody(style: string, selector: string): string {
  const match = new RegExp(
    `(^|\\n)${selector.replace(/[.#[\]="]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  ).exec(style);
  assert.ok(match, `missing rule for ${selector}`);
  return match[2] ?? "";
}

test("the api key section sits below the metrics and above the notifications", async () => {
  const html = await readFile(htmlPath, "utf8");

  const metrics = html.indexOf('class="metrics-card"');
  const apikey = html.indexOf('class="apikey-card"');
  const messages = html.indexOf('class="messages"');
  assert.ok(metrics >= 0 && apikey >= 0 && messages >= 0);
  assert.ok(metrics < apikey, "the key section must follow the metrics tiles");
  assert.ok(apikey < messages, "the key section must precede notifications");
  assert.match(html, /<section[^>]*class="apikey-card"[^>]*aria-label="[^"]+"/);
});

test("the key section is masked out of session replays", async () => {
  const html = await readFile(htmlPath, "utf8");
  const section =
    /<section[^>]*class="apikey-card"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  assert.match(section, /data-clarity-mask="true"/);
});

test("the key field is read-only and both controls carry accessible names", async () => {
  const html = await readFile(htmlPath, "utf8");
  const section =
    /<section[^>]*class="apikey-card"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  // The field is displayed, not editable, so it can only ever show the mask.
  assert.match(section, /id="api-key"[\s\S]*?readonly/);
  assert.match(section, /id="copy-api-key"[\s\S]*?aria-label="[^"]+"/);
  assert.match(section, /id="cycle-api-key"[\s\S]*?aria-label="[^"]+"/);
  // The feedback line announces copy/cycle results to assistive tech.
  assert.match(section, /id="api-key-status"[\s\S]*?aria-live="polite"/);
});

test("the field renders the masked value and never the raw key", async () => {
  const main = await readFile(mainPath, "utf8");

  // The visible input always carries the server mask.
  assert.match(main, /apiKeyValue\.value = key\.maskedKey/);
  // The raw key is only ever handed to the clipboard, never rendered.
  assert.doesNotMatch(main, /apiKeyValue\.value = .*apiKey\b/);
});

test("copying uses the in-memory full key with a documented execCommand fallback", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.match(main, /currentApiKey/);
  assert.match(main, /navigator\.clipboard\?\.writeText/);
  assert.match(main, /execCommand\("copy"\)/);
  // Awaiting before writeText would drop the iOS user gesture and fail.
  assert.doesNotMatch(main, /await\s+navigator\.clipboard/);
});

test("cycling requires an in-page two-step confirm rather than window.confirm", async () => {
  const main = await readFile(mainPath, "utf8");

  assert.doesNotMatch(main, /window\.confirm/);
  assert.match(main, /\/api\/apikey\/cycle/);
  // First click arms the control, a second click within the window cycles.
  assert.match(main, /dataset\.armed = "true"/);
  assert.match(main, /cycleApiKey\.dataset\.armed === "true"/);
  // Escape and an outside click both disarm the pending confirmation.
  assert.match(main, /event\.key !== "Escape"/);
  assert.match(main, /disarmCycle\(\)/);
  // The request disables the controls while it is in flight.
  assert.match(main, /cycleApiKey\.disabled = true/);
});

test("the masked field is monospace and clips instead of wrapping the buttons", async () => {
  const style = await readFile(stylePath, "utf8");

  const field = ruleBody(style, ".apikey-value");
  assert.match(field, /font-family:[^;]*monospace/);
  assert.match(field, /text-overflow:\s*ellipsis/);
  assert.match(field, /white-space:\s*nowrap/);
  assert.match(field, /overflow:\s*hidden/);

  // The field and both buttons share one height token, like the header does.
  assert.match(field, /height:\s*var\(--apikey-action-size\)/);
  assert.match(
    ruleBody(style, ".apikey-button"),
    /(width|height):\s*var\(--apikey-action-size\)/,
  );
});

test("the service worker never serves the api key endpoints from cache", async () => {
  const source = await readFile(workerPath, "utf8");

  interface FetchEvent {
    request: { method: string; mode?: string; url: string };
    respondWith(response: unknown): void;
  }
  type Handler = (event: FetchEvent) => void;

  const handlers = new Map<string, Handler>();
  const worker = {
    addEventListener(type: string, handler: Handler) {
      handlers.set(type, handler);
    },
    location: { origin: "https://example.test" },
  };
  const evaluate = new Function("self", "caches", "fetch", "Response", "URL", source);
  evaluate(worker, {}, () => undefined, Response, URL);

  const fetchHandler = handlers.get("fetch");
  assert.ok(fetchHandler);
  for (const path of ["/api/apikey", "/api/apikey/cycle"]) {
    let responded = false;
    fetchHandler({
      request: { method: "GET", mode: "cors", url: `https://example.test${path}` },
      respondWith() {
        responded = true;
      },
    });
    assert.equal(
      responded,
      false,
      `${path} must bypass the worker so it is never cached`,
    );
  }
});
