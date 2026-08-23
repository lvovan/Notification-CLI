import "./style.css";

interface NegotiationResponse {
  url: string;
}

interface PushConfigResponse {
  publicKey: string;
}

const METRIC_WINDOWS = [
  "last24Hours",
  "last7Days",
  "last30Days",
  "total",
] as const;

/** Long-lived home screen apps still pick up a deployment within the hour. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** One resume can fire pageshow, focus and visibilitychange together. */
const UPDATE_CHECK_THROTTLE_MS = 60 * 1000;
const NOTIFICATION_HISTORY_PAGE_SIZE = 5;

type NotificationCounts = Record<(typeof METRIC_WINDOWS)[number], number>;

interface IncomingNotification {
  id?: string;
  message: string;
  sentAt?: number;
}

interface RetainedNotification {
  id: string;
  body: string;
  sentAt: number;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const status = requiredElement("status");
const statusDot = requiredElement("status-dot");
const messageList = requiredElement<HTMLOListElement>("message-list");
const emptyState = requiredElement("empty-state");
const toggleNotifications = requiredElement<HTMLButtonElement>(
  "toggle-notifications",
);
const pushStatus = requiredElement("push-status");
const metricsStatus = requiredElement("metrics-status");
const messagesStatus = requiredElement("messages-status");
const messageListSentinel = requiredElement("message-list-sentinel");
const refreshMessages = requiredElement<HTMLButtonElement>("refresh-messages");
const statusCard = requiredElement<HTMLElement>("status").closest(
  ".status-card",
);
if (!statusCard) {
  throw new Error("Missing status card");
}

const appActions = document.createElement("div");
appActions.className = "app-actions";
const installButton = createActionButton("Install app", "install-app");
const connectivity = document.createElement("p");
connectivity.className = "connectivity";
connectivity.setAttribute("role", "status");
connectivity.setAttribute("aria-live", "polite");
installButton.hidden = true;
connectivity.hidden = true;
appActions.append(installButton);
statusCard.after(connectivity);
statusCard.append(appActions);

let reconnectAttempts = 0;
let reconnectTimer: number | undefined;
let deliberatelyClosed = false;
let installPrompt: BeforeInstallPromptEvent | undefined;
let refreshing = false;
let pushBusy = false;
let notificationHistoryCursor: string | null | undefined;
let notificationHistoryLoading = false;
let notificationHistoryGeneration = 0;
let notificationHistoryObserver: IntersectionObserver | undefined;
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
): void {
  statusDot.className = `status-dot ${state}`;
  status.textContent = title;
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
  setStatus("connecting", "Connecting...");

  try {
    const socket = new WebSocket(await negotiate());
    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("connected", "Connected");
    });
    socket.addEventListener("message", (event) => {
      const notification = parseIncomingNotification(event.data);
      displayMessage(notification.message, notification.id, notification.sentAt);
      void refreshMetrics();
    });
    socket.addEventListener("close", () => {
      if (!deliberatelyClosed) {
        scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => socket.close());
  } catch {
    setStatus("disconnected", "Disconnected");
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
  setStatus("disconnected", "Disconnected");
  reconnectTimer = window.setTimeout(() => void connect(), delay);
}

function setOfflineState(): void {
  window.clearTimeout(reconnectTimer);
  setStatus("disconnected", "Offline");
  connectivity.textContent =
    "You are offline. Notification CLI is running from its cached app shell.";
  connectivity.hidden = false;
}

function decodeJsonPayload(value: string): unknown {
  let current: unknown = value;
  // Payloads can arrive JSON-encoded more than once depending on how the
  // transport serializes them, so unwrap nested string encodings.
  for (let depth = 0; depth < 3 && typeof current === "string"; depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return current;
    }
  }
  return current;
}

function parseIncomingNotification(value: unknown): IncomingNotification {
  if (typeof value !== "string") {
    return { message: "New notification" };
  }
  const payload = decodeJsonPayload(value);
  if (typeof payload === "string") {
    return { message: payload };
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message =
      typeof record.body === "string"
        ? record.body
        : typeof record.message === "string"
          ? record.message
          : JSON.stringify(payload, null, 2);
    return {
      message,
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(typeof record.sentAt === "number" ? { sentAt: record.sentAt } : {}),
    };
  }
  return { message: String(payload) };
}

function formatSentAt(sent: Date): string {
  const time: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  return sent.toDateString() === new Date().toDateString()
    ? sent.toLocaleTimeString([], time)
    : sent.toLocaleString([], { month: "short", day: "numeric", ...time });
}

function displayMessage(
  message: string,
  id?: string,
  sentAt: number = Date.now(),
): void {
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
  const sent = new Date(sentAt);
  item.dataset.sentAt = String(sentAt);
  body.textContent = message;
  time.dateTime = sent.toISOString();
  time.textContent = formatSentAt(sent);
  item.append(body, time);
  // Retained history and live messages can arrive in any order, so each entry
  // is placed by its send time to keep the list newest-first.
  const older = Array.from(messageList.children).find(
    (child) => Number((child as HTMLElement).dataset.sentAt ?? 0) < sentAt,
  );
  messageList.insertBefore(item, older ?? null);
}

/** Carries the HTTP status so expired sessions can offer a sign-in link. */
class SessionAwareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function setHistoryStatus(retentionDays: number | undefined): void {
  messagesStatus.textContent =
    typeof retentionDays === "number"
      ? `Notifications are kept for ${retentionDays} day${
          retentionDays === 1 ? "" : "s"
        }.`
      : "";
  messagesStatus.classList.remove("error");
}

function setHistoryError(error: unknown, isFirstPage: boolean): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  const subject = isFirstPage ? "notifications" : "earlier notifications";
  messagesStatus.replaceChildren(`Unable to load ${subject}: ${detail} `);
  messagesStatus.classList.add("error");
  if (
    error instanceof SessionAwareError &&
    (error.status === 401 || error.status === 403)
  ) {
    const signIn = document.createElement("a");
    signIn.href = "/.auth/login/aad?post_login_redirect_uri=/";
    signIn.textContent = "Sign in again";
    messagesStatus.append(signIn);
    return;
  }

  const retry = createActionButton("Retry", "retry-notification-history");
  retry.addEventListener("click", () => void loadNotificationHistory());
  messagesStatus.append(retry);
}

function stopNotificationHistoryPaging(): void {
  notificationHistoryCursor = null;
  notificationHistoryObserver?.disconnect();
  notificationHistoryObserver = undefined;
}

function isHistorySentinelNearViewport(): boolean {
  return (
    messageListSentinel.getBoundingClientRect().top <= window.innerHeight + 160
  );
}

async function loadNotificationHistory(): Promise<void> {
  if (notificationHistoryLoading || notificationHistoryCursor === null) {
    return;
  }

  notificationHistoryLoading = true;
  const generation = notificationHistoryGeneration;
  const isFirstPage = notificationHistoryCursor === undefined;
  messagesStatus.textContent = isFirstPage
    ? "Loading notifications..."
    : "Loading earlier notifications...";
  messagesStatus.classList.remove("error");
  let shouldLoadNextPage = false;

  try {
    const cursor = notificationHistoryCursor;
    const query = new URLSearchParams({
      limit: String(NOTIFICATION_HISTORY_PAGE_SIZE),
      ...(cursor !== undefined ? { before: cursor } : {}),
    });
    const response = await fetch(`/api/notifications?${query}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = (await response.json()) as {
      retentionDays?: number;
      notifications?: RetainedNotification[];
      nextCursor?: string | null;
      error?: unknown;
    };
    // A refresh started while this page was in flight, so it is now stale.
    if (generation !== notificationHistoryGeneration) {
      return;
    }
    if (!response.ok) {
      throw new SessionAwareError(
        typeof body.error === "string"
          ? body.error
          : `history request failed (${response.status})`,
        response.status,
      );
    }
    for (const entry of body.notifications ?? []) {
      if (typeof entry.body === "string" && typeof entry.sentAt === "number") {
        displayMessage(entry.body, entry.id, entry.sentAt);
      }
    }
    notificationHistoryCursor =
      typeof body.nextCursor === "string" ? body.nextCursor : null;
    setHistoryStatus(body.retentionDays);
    if (notificationHistoryCursor === null) {
      stopNotificationHistoryPaging();
    } else {
      shouldLoadNextPage = isHistorySentinelNearViewport();
    }
  } catch (error) {
    if (generation === notificationHistoryGeneration) {
      setHistoryError(error, isFirstPage);
    }
  } finally {
    if (generation === notificationHistoryGeneration) {
      notificationHistoryLoading = false;
    }
  }

  if (shouldLoadNextPage) {
    void loadNotificationHistory();
  }
}

function watchNotificationHistoryPaging(): void {
  notificationHistoryObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadNotificationHistory();
      }
    },
    { rootMargin: "160px 0px" },
  );
  notificationHistoryObserver.observe(messageListSentinel);
}

/**
 * Discards the rendered history and pages it in again from the newest entry,
 * so anything missed while the socket was down shows up.
 */
async function reloadNotificationHistory(): Promise<void> {
  refreshMessages.disabled = true;
  // Invalidates any page still in flight so it cannot repopulate the list.
  notificationHistoryGeneration += 1;
  notificationHistoryLoading = false;
  displayedNotificationIds.clear();
  messageList.replaceChildren(emptyState);
  notificationHistoryCursor = undefined;
  // Paging disconnects itself at the end of the list, so it must restart.
  notificationHistoryObserver?.disconnect();
  watchNotificationHistoryPaging();

  try {
    await Promise.all([loadNotificationHistory(), refreshMetrics()]);
  } finally {
    refreshMessages.disabled = false;
  }
}

/**
 * Caps the rendered value at five characters so no count can overflow a tile.
 * The exact figure stays available as the element's tooltip.
 */
function formatMetric(value: number): string {
  return value < 10_000
    ? value.toLocaleString()
    : value.toLocaleString(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      });
}

async function refreshMetrics(): Promise<void> {
  try {
    const response = await fetch("/api/metrics", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = (await response.json()) as Partial<NotificationCounts> & {
      error?: unknown;
    };
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `metrics request failed (${response.status})`,
      );
    }
    for (const window of METRIC_WINDOWS) {
      const value = body[window];
      const element = requiredElement(`metric-${window}`);
      element.textContent =
        typeof value === "number" ? formatMetric(value) : "-";
      element.title = typeof value === "number" ? value.toLocaleString() : "";
    }
    metricsStatus.textContent = "";
    metricsStatus.classList.remove("error");
  } catch (error) {
    metricsStatus.textContent = `Unable to load metrics: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
    metricsStatus.classList.add("error");
  }
}

async function runPushTask(
  action: () => Promise<void>,
  failureContext: string,
): Promise<void> {
  if (pushBusy) {
    return;
  }

  pushBusy = true;
  toggleNotifications.disabled = true;
  try {
    await action();
  } catch (error) {
    setPushError(failureContext, error);
  } finally {
    pushBusy = false;
    toggleNotifications.disabled = false;
  }
}

function enablePushNotifications(): Promise<void> {
  return runPushTask(async () => {
    setPushStatus("Waiting for notification permission...");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushEnabled(false);
      setPushStatus(
        permission === "denied"
          ? "Notifications are blocked. Allow them in browser settings."
          : "Notification permission was not granted.",
        true,
      );
      return;
    }
    await syncPushSubscription();
  }, "Unable to enable notifications");
}

/** Keeps the bell glyph, its accessible name and the status line in step. */
function setPushEnabled(enabled: boolean): void {
  const label = enabled ? "Disable notifications" : "Enable notifications";
  toggleNotifications.textContent = enabled ? "🔔" : "🔕";
  toggleNotifications.setAttribute("aria-pressed", String(enabled));
  toggleNotifications.setAttribute("aria-label", label);
  toggleNotifications.title = label;
  setPushStatus(enabled ? "Notifications enabled" : "Notifications disabled");
}

function setPushStatus(message: string, isError = false): void {
  pushStatus.textContent = message;
  pushStatus.classList.toggle("error", isError);
}

function setPushError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  setPushStatus(`${context}: ${detail}`, true);
  if (
    error instanceof SessionAwareError &&
    (error.status === 401 || error.status === 403)
  ) {
    // The Microsoft session expired or lost its identity while the page stayed
    // open, so recovering needs a fresh sign-in rather than a retry.
    const signIn = document.createElement("a");
    signIn.href = "/.auth/login/aad?post_login_redirect_uri=/";
    signIn.textContent = "Sign in again";
    pushStatus.append(" ", signIn);
  }
}

async function fetchPushConfig(): Promise<string> {
  const response = await fetch("/api/push/config", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new SessionAwareError(
      typeof body?.error === "string"
        ? body.error
        : `configuration request failed (${response.status})`,
      response.status,
    );
  }

  const config = (await response.json()) as Partial<PushConfigResponse>;
  if (typeof config.publicKey !== "string" || config.publicKey.length === 0) {
    throw new Error("server returned an invalid public key");
  }
  return config.publicKey;
}

/**
 * `navigator.serviceWorker.ready` never settles when installation fails, so it
 * is bounded to keep the interface out of a permanent "setting up" state.
 */
function activeServiceWorker(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      window.setTimeout(
        () =>
          reject(
            new Error("the offline service worker did not finish installing"),
          ),
        15_000,
      );
    }),
  ]);
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
    throw new SessionAwareError(
      `subscription request failed (${response.status})`,
      response.status,
    );
  }
}

async function syncPushSubscription(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toggleNotifications.hidden = true;
    setPushStatus("Notifications are not supported by this browser.", true);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  setPushStatus("Enabling notifications...");
  const registration = await activeServiceWorker();
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
  setPushEnabled(true);
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

/**
 * Derives the toggle state from the live subscription rather than from the
 * permission alone, so turning notifications off is not undone by a reload.
 */
async function restorePushState(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toggleNotifications.hidden = true;
    setPushStatus("Notifications are not supported by this browser.", true);
    return;
  }
  const registration = await activeServiceWorker();
  if (await registration.pushManager.getSubscription()) {
    await syncPushSubscription();
  }
}

function disablePushNotifications(): Promise<void> {
  return runPushTask(async () => {
    setPushStatus("Disabling notifications...");
    const registration = await activeServiceWorker();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      setPushEnabled(false);
      return;
    }

    const payload = JSON.stringify(subscription.toJSON());
    const failures: string[] = [];
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
      if (!(await subscription.unsubscribe())) {
        failures.push("browser removal was not confirmed");
      }
    } catch {
      failures.push("browser removal failed");
    }

    setPushEnabled(false);
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  }, "Unable to fully disable notifications");
}

function applyServiceWorkerUpdate(worker: ServiceWorker): void {
  connectivity.textContent = "Updating to the latest version...";
  connectivity.hidden = false;
  worker.postMessage({ type: "SKIP_WAITING" });
}

/**
 * iOS home screen apps resume from the back/forward cache and often skip
 * `visibilitychange`, so every plausible resume signal triggers a check. The
 * checks are throttled because several of them fire together on one resume.
 */
function watchServiceWorkerRegistration(
  registration: ServiceWorkerRegistration,
): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    applyServiceWorkerUpdate(registration.waiting);
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
        applyServiceWorkerUpdate(worker);
      }
    });
  });

  let lastUpdateCheck = Date.now();
  const checkForUpdate = (): void => {
    const now = Date.now();
    if (!navigator.onLine || now - lastUpdateCheck < UPDATE_CHECK_THROTTLE_MS) {
      return;
    }
    lastUpdateCheck = now;
    void registration.update();
  };

  window.addEventListener("online", checkForUpdate);
  window.addEventListener("pageshow", checkForUpdate);
  window.addEventListener("focus", checkForUpdate);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForUpdate();
    }
  });
  window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
}

async function registerServiceWorker(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.register(
      "/service-worker.js",
      // Never let the HTTP cache answer the worker update check.
      { updateViaCache: "none" },
    );
    watchServiceWorkerRegistration(registration);
  } catch {
    connectivity.textContent =
      "Offline support could not be enabled in this browser.";
    connectivity.hidden = false;
  }
}

refreshMessages.addEventListener("click", () => {
  void reloadNotificationHistory();
});
toggleNotifications.addEventListener("click", () => {
  void (toggleNotifications.getAttribute("aria-pressed") === "true"
    ? disablePushNotifications()
    : enablePushNotifications());
});
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

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (
      event.data?.type === "PUSH_NOTIFICATION" &&
      typeof event.data.message === "string"
    ) {
      displayMessage(
        event.data.message,
        typeof event.data.id === "string" ? event.data.id : undefined,
        typeof event.data.sentAt === "number" ? event.data.sentAt : undefined,
      );
      void refreshMetrics();
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
  setPushEnabled(false);
  if (Notification.permission === "granted") {
    void runPushTask(restorePushState, "Unable to refresh notifications");
  } else if (Notification.permission === "denied") {
    toggleNotifications.disabled = true;
    setPushStatus(
      "Notifications are blocked. Allow them in browser settings.",
      true,
    );
  }
} else {
  toggleNotifications.hidden = true;
  setPushStatus("Notifications are not supported by this browser.", true);
}

void connect();
void refreshMetrics();
watchNotificationHistoryPaging();
void loadNotificationHistory();
