import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

interface WorkerEvent {
  data?: { json(): unknown; text(): string };
  waitUntil(promise: Promise<unknown>): void;
}

type WorkerHandler = (event: WorkerEvent) => void;

async function loadPushHandler(visible: boolean) {
  const source = await readFile(
    resolve("../web/public/service-worker.js"),
    "utf8",
  );
  const handlers = new Map<string, WorkerHandler>();
  const notifications: Array<{ title: string; options: unknown }> = [];
  const messages: unknown[] = [];
  const worker = {
    addEventListener(type: string, handler: WorkerHandler) {
      handlers.set(type, handler);
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [
        {
          visibilityState: visible ? "visible" : "hidden",
          postMessage: (message: unknown) => messages.push(message),
        },
      ],
    },
    registration: {
      showNotification: async (title: string, options: unknown) => {
        notifications.push({ title, options });
      },
    },
    location: { origin: "https://example.test" },
    skipWaiting: () => undefined,
  };

  const evaluate = new Function(
    "self",
    "caches",
    "fetch",
    "Response",
    "URL",
    source,
  );
  evaluate(worker, {}, () => undefined, Response, URL);
  const push = handlers.get("push");
  assert.ok(push);
  return { push, notifications, messages };
}

test("background push displays a system notification", async () => {
  const { push, notifications } = await loadPushHandler(false);
  let completion: Promise<unknown> | undefined;
  push({
    data: {
      json: () => ({
        id: "notification-id",
        title: "Notification CLI",
        body: "Build complete",
      }),
      text: () => "",
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  await completion;

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Notification CLI");
});

test("visible clients receive push payloads without duplicate system notifications", async () => {
  const { push, notifications, messages } = await loadPushHandler(true);
  let completion: Promise<unknown> | undefined;
  push({
    data: {
      json: () => ({
        id: "notification-id",
        title: "Notification CLI",
        body: "Build complete",
      }),
      text: () => "",
    },
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  await completion;

  assert.deepEqual(notifications, []);
  assert.deepEqual(messages, [
    {
      type: "PUSH_NOTIFICATION",
      id: "notification-id",
      message: "Build complete",
    },
  ]);
});
