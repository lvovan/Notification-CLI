self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/.auth/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

self.addEventListener("push", (event) => {
  const notification = parsePushNotification(event.data);
  event.waitUntil(showBackgroundNotification(notification));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        return existing
          ? existing.focus()
          : self.clients.openWindow(event.notification.data?.url ?? "/");
      }),
  );
});

const CACHE_PREFIX = "notification-cli-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const APP_SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];
const CACHEABLE_ASSET = /\.(?:css|js|mjs|json|webmanifest|png|svg|ico|woff2?)$/;

/**
 * Authentication endpoints must never be fetched or cached by the worker:
 * requesting /.auth/logout during install would sign the user out.
 */
function isCacheableAssetPath(pathname) {
  return (
    !pathname.startsWith("/.auth/") &&
    !pathname.startsWith("/api/") &&
    CACHEABLE_ASSET.test(pathname)
  );
}

function parsePushNotification(data) {
  const defaults = {
    id: undefined,
    title: "Notification CLI",
    body: "New notification",
    tag: `push-${Date.now()}`,
  };
  if (!data) {
    return defaults;
  }

  try {
    const payload = data.json();
    if (typeof payload === "string" && payload) {
      return { ...defaults, body: payload };
    }
    if (payload && typeof payload === "object") {
      return {
        id:
          typeof payload.id === "string" && payload.id
            ? payload.id
            : defaults.id,
        title:
          typeof payload.title === "string" && payload.title
            ? payload.title
            : defaults.title,
        body:
          typeof payload.body === "string" && payload.body
            ? payload.body
            : typeof payload.message === "string" && payload.message
              ? payload.message
            : defaults.body,
        tag:
          typeof payload.tag === "string" && payload.tag
            ? payload.tag
            : defaults.tag,
      };
    }
  } catch {
    const text = data.text();
    if (text) {
      return { ...defaults, body: text };
    }
  }
  return defaults;
}

async function showBackgroundNotification(notification) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const visibleWindows = windows.filter(
    (client) => client.visibilityState === "visible",
  );
  if (visibleWindows.length > 0) {
    for (const client of visibleWindows) {
      client.postMessage({
        type: "PUSH_NOTIFICATION",
        id: notification.id,
        message: notification.body,
      });
    }
    return;
  }
  await self.registration.showNotification(notification.title, {
    body: notification.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: notification.id ?? notification.tag,
    data: { url: "/" },
  });
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch("/index.html", { cache: "reload" });
  if (!indexResponse.ok) {
    throw new Error("Unable to cache the application shell");
  }

  await cache.put("/index.html", indexResponse.clone());
  await cache.put("/", indexResponse.clone());

  const html = await indexResponse.text();
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter(
      (url) =>
        url.origin === self.location.origin &&
        isCacheableAssetPath(url.pathname),
    )
    .map((url) => `${url.pathname}${url.search}`);

  // Individual assets are cached independently so a single missing icon
  // cannot reject installation and leave the worker permanently inactive.
  await Promise.allSettled(
    [...new Set([...APP_SHELL, ...assetUrls])].map((url) => cache.add(url)),
  );
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (
      (await cache.match(request)) ??
      (await cache.match("/index.html")) ??
      Response.error()
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
}
