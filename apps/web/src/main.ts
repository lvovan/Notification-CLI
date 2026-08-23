import "./style.css";

interface NegotiationResponse {
  url: string;
}

interface PushConfigResponse {
  publicKey: string;
}

interface IncomingNotification {
  id?: string;
  message: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const status = requiredElement("status");
const statusDetail = requiredElement("status-detail");
const statusDot = requiredElement("status-dot");
const messageList = requiredElement<HTMLOListElement>("message-list");
const emptyState = requiredElement("empty-state");
const enableNotifications = requiredElement<HTMLButtonElement>(
  "enable-notifications",
);
const disableNotifications = requiredElement<HTMLButtonElement>(
  "disable-notifications",
);
const pushStatus = requiredElement("push-status");
const clearButton = requiredElement<HTMLButtonElement>("clear");
const statusCard = requiredElement<HTMLElement>("status").closest(
  ".status-card",
);
if (!statusCard) {
  throw new Error("Missing status card");
}

const appActions = document.createElement("div");
appActions.className = "app-actions";
const installButton = createActionButton("Install app", "install-app");
const updateButton = createActionButton("Update app", "update-app");
const connectivity = document.createElement("p");
connectivity.className = "connectivity";
connectivity.setAttribute("role", "status");
connectivity.setAttribute("aria-live", "polite");
installButton.hidden = true;
updateButton.hidden = true;
connectivity.hidden = true;
appActions.append(installButton, updateButton);
statusCard.after(connectivity);
statusCard.append(appActions);

let reconnectAttempts = 0;
let reconnectTimer: number | undefined;
let deliberatelyClosed = false;
let installPrompt: BeforeInstallPromptEvent | undefined;
let waitingWorker: ServiceWorker | undefined;
let refreshing = false;
let pushBusy = false;
const displayedNotificationIds = new Set<string>();

function createActionButton(label: string, id: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.textContent = label;
  return button;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function setStatus(
  state: "connected" | "connecting" | "disconnected",
  title: string,
  detail: string,
): void {
  statusDot.className = `status-dot ${state}`;
  status.textContent = title;
  statusDetail.textContent = detail;
}

async function negotiate(): Promise<string> {
  const response = await fetch("/api/negotiate", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Negotiation failed (${response.status})`);
  }
  const body = (await response.json()) as Partial<NegotiationResponse>;
  if (typeof body.url !== "string" || !body.url.startsWith("wss://")) {
    throw new Error("Negotiation did not return a secure WebSocket URL");
  }
  return body.url;
}

async function connect(): Promise<void> {
  window.clearTimeout(reconnectTimer);
  if (!navigator.onLine) {
    setOfflineState();
    return;
  }
  setStatus("connecting", "Connecting...", "Establishing a secure connection");

  try {
    const socket = new WebSocket(await negotiate());
    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("connected", "Connected", "Listening for notifications");
    });
    socket.addEventListener("message", (event) => {
      const notification = parseIncomingNotification(event.data);
      displayMessage(notification.message, notification.id);
    });
    socket.addEventListener("close", () => {
      if (!deliberatelyClosed) {
        scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => socket.close());
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Connection failed";
    setStatus("disconnected", "Disconnected", detail);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (!navigator.onLine) {
    setOfflineState();
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(30_000, 1000 * 2 ** (reconnectAttempts - 1));
  setStatus(
    "disconnected",
    "Disconnected",
    `Reconnecting in ${Math.ceil(delay / 1000)} seconds`,
  );
  reconnectTimer = window.setTimeout(() => void connect(), delay);
}

function setOfflineState(): void {
  window.clearTimeout(reconnectTimer);
  setStatus(
    "disconnected",
    "Offline",
    "Cached messages remain available. Live updates will resume when online.",
  );
  connectivity.textContent =
    "You are offline. Notification CLI is running from its cached app shell.";
  connectivity.hidden = false;
}

function parseIncomingNotification(value: unknown): IncomingNotification {
  if (typeof value !== "string") {
    return { message: "New notification" };
  }
  try {
    const payload = JSON.parse(value) as {
      id?: unknown;
      body?: unknown;
      message?: unknown;
    };
    const message =
      typeof payload.body === "string"
        ? payload.body
        : typeof payload.message === "string"
          ? payload.message
          : value;
    return typeof payload.id === "string"
      ? { id: payload.id, message }
      : { message };
  } catch {
    return { message: value };
  }
}

function displayMessage(message: string, id?: string): void {
  if (id && displayedNotificationIds.has(id)) {
    return;
  }
  if (id) {
    displayedNotificationIds.add(id);
  }
  emptyState.remove();
  const item = document.createElement("li");
  const body = document.createElement("p");
  const time = document.createElement("time");
  const now = new Date();
  body.textContent = message;
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  item.append(body, time);
  messageList.prepend(item);
}

async function requestNotificationPermission(): Promise<void> {
  if (pushBusy) {
    return;
  }

  pushBusy = true;
  enableNotifications.disabled = true;
  setPushStatus("Waiting for notification permission...");
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      enableNotifications.hidden = permission === "denied";
      setPushStatus(
        permission === "denied"
          ? "Notifications are blocked. Allow them in browser settings to enable background notifications."
          : "Notification permission was not granted.",
        true,
      );
      return;
    }
    await syncPushSubscription();
  } catch (error) {
    setPushError("Unable to enable background notifications", error);
  } finally {
    pushBusy = false;
    enableNotifications.disabled = false;
  }
}

function setPushStatus(message: string, isError = false): void {
  pushStatus.textContent = message;
  pushStatus.classList.toggle("error", isError);
}

function setPushError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  setPushStatus(`${context}: ${detail}`, true);
}

async function fetchPushConfig(): Promise<string> {
  const response = await fetch("/api/push/config", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`configuration request failed (${response.status})`);
  }

  const config = (await response.json()) as Partial<PushConfigResponse>;
  if (typeof config.publicKey !== "string" || config.publicKey.length === 0) {
    throw new Error("server returned an invalid public key");
  }
  return config.publicKey;
}

function decodeApplicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const decoded = window.atob(base64);
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return buffer;
}

async function savePushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) {
    throw new Error(`subscription request failed (${response.status})`);
  }
}

async function syncPushSubscription(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    enableNotifications.hidden = true;
    setPushStatus(
      "Background notifications are not supported by this browser.",
      true,
    );
    return;
  }
  if (
    !("Notification" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }

  setPushStatus("Setting up background notifications...");
  const registration = await navigator.serviceWorker.ready;
  const publicKey = await fetchPushConfig();
  const applicationServerKey = decodeApplicationServerKey(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription &&
    !keysEqual(subscription.options.applicationServerKey, applicationServerKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  await savePushSubscription(subscription);
  enableNotifications.hidden = true;
  disableNotifications.hidden = false;
  setPushStatus("Background notifications are enabled.");
}

function keysEqual(
  actual: ArrayBuffer | null,
  expected: ArrayBuffer,
): boolean {
  if (!actual) {
    return false;
  }
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    actualBytes.every((value, index) => value === expectedBytes[index])
  );
}

async function unsubscribeFromPush(): Promise<void> {
  if (pushBusy || !("serviceWorker" in navigator)) {
    return;
  }

  pushBusy = true;
  disableNotifications.disabled = true;
  setPushStatus("Disabling background notifications...");
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      enableNotifications.hidden = Notification.permission !== "granted";
      disableNotifications.hidden = true;
      setPushStatus("Background notifications are already disabled.");
      return;
    }

    const payload = JSON.stringify(subscription.toJSON());
    const failures: string[] = [];
    let browserRemoved = false;
    try {
      const response = await fetch("/api/push/subscriptions", {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: payload,
      });
      if (!response.ok) {
        failures.push(`server removal failed (${response.status})`);
      }
    } catch {
      failures.push("server removal failed");
    }

    try {
      browserRemoved = await subscription.unsubscribe();
      if (!browserRemoved) {
        failures.push("browser removal was not confirmed");
      }
    } catch {
      failures.push("browser removal failed");
    }

    enableNotifications.hidden =
      !browserRemoved || Notification.permission !== "granted";
    disableNotifications.hidden = browserRemoved;
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
    setPushStatus("Background notifications are disabled.");
  } catch (error) {
    setPushError("Unable to fully disable background notifications", error);
  } finally {
    pushBusy = false;
    disableNotifications.disabled = false;
  }
}

function offerServiceWorkerUpdate(worker: ServiceWorker): void {
  waitingWorker = worker;
  updateButton.hidden = false;
  connectivity.textContent =
    "A new version is ready. Update when convenient to use it.";
  connectivity.hidden = false;
}

function watchServiceWorkerRegistration(
  registration: ServiceWorkerRegistration,
): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    offerServiceWorkerUpdate(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) {
      return;
    }
    worker.addEventListener("statechange", () => {
      if (
        worker.state === "installed" &&
        navigator.serviceWorker.controller
      ) {
        offerServiceWorkerUpdate(worker);
      }
    });
  });

  window.addEventListener("online", () => void registration.update());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      void registration.update();
    }
  });
}

async function registerServiceWorker(): Promise<void> {
  try {
    const registration =
      await navigator.serviceWorker.register("/service-worker.js");
    watchServiceWorkerRegistration(registration);
  } catch {
    connectivity.textContent =
      "Offline support could not be enabled in this browser.";
    connectivity.hidden = false;
  }
}

clearButton.addEventListener("click", () => {
  messageList.replaceChildren(emptyState);
});
enableNotifications.addEventListener(
  "click",
  () => void requestNotificationPermission(),
);
disableNotifications.addEventListener(
  "click",
  () => void unsubscribeFromPush(),
);
window.addEventListener("beforeunload", () => {
  deliberatelyClosed = true;
});
window.addEventListener("offline", setOfflineState);
window.addEventListener("online", () => {
  reconnectAttempts = 0;
  connectivity.hidden = true;
  void connect();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as BeforeInstallPromptEvent;
  installButton.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  installButton.hidden = true;
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) {
    return;
  }
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = undefined;
  installButton.hidden = true;
});
updateButton.addEventListener("click", () => {
  updateButton.disabled = true;
  waitingWorker?.postMessage({ type: "SKIP_WAITING" });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (
      event.data?.type === "PUSH_NOTIFICATION" &&
      typeof event.data.message === "string"
    ) {
      displayMessage(
        event.data.message,
        typeof event.data.id === "string" ? event.data.id : undefined,
      );
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    window.location.reload();
  });
  void registerServiceWorker();
}
if ("Notification" in window) {
  if (Notification.permission === "granted") {
    enableNotifications.hidden = true;
    void syncPushSubscription().catch((error: unknown) => {
      enableNotifications.hidden = false;
      setPushError("Unable to refresh background notifications", error);
    });
  } else if (Notification.permission === "denied") {
    enableNotifications.hidden = true;
    setPushStatus(
      "Notifications are blocked. Allow them in browser settings to enable background notifications.",
      true,
    );
  }
} else {
  enableNotifications.hidden = true;
  setPushStatus("Notifications are not supported by this browser.", true);
}

void connect();
