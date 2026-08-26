import "./style.css";
import { pushHelpGuidance } from "./push-help.js";
import type { NotificationSource } from "@notification-cli/core/telemetry";
import { NOTIFICATION_SOURCES, NOTIFICATION_SOURCE_HEADER } from "@notification-cli/core/telemetry";
import {
  ACTIVITY_BUCKETS,
  bucket,
  CLARITY_EVENTS,
  CLARITY_TAGS,
  platformName,
  startTelemetry,
  tagSession,
  trackEvent,
  trackNotificationArrival,
  VOLUME_BUCKETS,
} from "./telemetry.js";

interface NegotiationResponse {
  url: string;
}

interface PushConfigResponse {
  publicKey: string;
}

interface ApiKeyResponse {
  apiKey: string;
  maskedKey: string;
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
const TEST_NOTIFICATION_MESSAGE = "Test notification from the web app";
const TEST_NOTIFICATION_SUCCESS =
  "Test notification sent. Waiting for it to arrive...";
const TEST_NOTIFICATION_FEEDBACK_MS = 3000;
/** Short, single-line label that opens the push help dialog when tapped. */
const PUSH_UNAVAILABLE_LABEL = "Notifications unavailable";
const SVG_NS = "http://www.w3.org/2000/svg";
const TRASH_ICON_PATH =
  "M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 11H7.7L7 9Zm2 2 .45 7h1.6l-.35-7H9Zm4.3 0-.35 7h1.6L15 11h-1.7Z";

type NotificationCounts = Record<(typeof METRIC_WINDOWS)[number], number>;

interface IncomingNotification {
  id?: string;
  message: string;
  sentAt?: number;
  /** Set by the server on live deliveries only; absent from stored history. */
  source?: NotificationSource;
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
const statusDot = requiredElement<HTMLButtonElement>("status-dot");
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
const clearMessages = requiredElement<HTMLButtonElement>("clear-messages");
const cancelClear = requiredElement<HTMLButtonElement>("cancel-clear");
const apiKeyValue = requiredElement<HTMLInputElement>("api-key");
const copyApiKey = requiredElement<HTMLButtonElement>("copy-api-key");
const cycleApiKey = requiredElement<HTMLButtonElement>("cycle-api-key");
const apiKeyStatus = requiredElement("api-key-status");
const accountEmail = requiredElement("account-email");
const statusCard = requiredElement<HTMLElement>("status").closest(
  ".status-card",
);
if (!statusCard) {
  throw new Error("Missing status card");
}

function createTrashIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("class", "heading-action-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", TRASH_ICON_PATH);
  icon.append(path);

  return icon;
}

function restoreClearMessagesIcon(): void {
  clearMessages.replaceChildren(createTrashIcon());
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

/** The full key is held only in memory so the copy stays in the click gesture. */
let currentApiKey: string | undefined;
let apiKeyGeneration = 0;
let apiKeyCycleBusy = false;
let copyFeedbackTimer: number | undefined;
let cycleArmTimer: number | undefined;
const CYCLE_ARM_TIMEOUT_MS = 4000;
let clearArmTimer: number | undefined;
let clearBusy = false;
let lastRetentionDays: number | undefined;
let testNotificationBusy = false;
let testNotificationFeedbackTimer: number | undefined;

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
  tagSession(CLARITY_TAGS.connection, title === "Offline" ? "offline" : state);
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
      trackNotificationArrival(notification.source);
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
  if (reconnectAttempts === 1) {
    trackEvent(CLARITY_EVENTS.connectionLost);
  }
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

function isNotificationSource(value: unknown): value is NotificationSource {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SOURCES as readonly string[]).includes(value)
  );
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
      ...(isNotificationSource(record.source)
        ? { source: record.source }
        : {}),
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
  lastRetentionDays = retentionDays;
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
    error.status === 401
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

function clearTestNotificationFeedback(): void {
  window.clearTimeout(testNotificationFeedbackTimer);
  testNotificationFeedbackTimer = undefined;
  // This line is shared with history loading; if anything newer wrote here
  // during the timeout, leave that newer status or error alone.
  if (messagesStatus.textContent === TEST_NOTIFICATION_SUCCESS) {
    setHistoryStatus(lastRetentionDays);
  }
}

function showTestNotificationProgress(message: string): void {
  window.clearTimeout(testNotificationFeedbackTimer);
  messagesStatus.textContent = message;
  messagesStatus.classList.remove("error");
}

function showTransientTestNotificationStatus(message: string): void {
  showTestNotificationProgress(message);
  testNotificationFeedbackTimer = window.setTimeout(
    clearTestNotificationFeedback,
    TEST_NOTIFICATION_FEEDBACK_MS,
  );
}

function setTestNotificationError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  window.clearTimeout(testNotificationFeedbackTimer);
  messagesStatus.replaceChildren(`${context}: ${detail} `);
  messagesStatus.classList.add("error");
  if (error instanceof SessionAwareError && error.status === 401) {
    const signIn = document.createElement("a");
    signIn.href = "/.auth/login/aad?post_login_redirect_uri=/";
    signIn.textContent = "Sign in again";
    messagesStatus.append(signIn);
  }
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
    // Paging depth shows whether anyone actually reads back through history or
    // only ever looks at what is on screen.
    trackEvent(CLARITY_EVENTS.historyPageLoaded);
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

/** Empties the rendered list and restarts paging from the newest entry. */
function resetNotificationList(): void {
  // Invalidates any page still in flight so it cannot repopulate the list.
  notificationHistoryGeneration += 1;
  notificationHistoryLoading = false;
  displayedNotificationIds.clear();
  messageList.replaceChildren(emptyState);
  notificationHistoryCursor = undefined;
  // Paging disconnects itself at the end of the list, so it must restart.
  notificationHistoryObserver?.disconnect();
  watchNotificationHistoryPaging();
}

/**
 * Discards the rendered history and pages it in again from the newest entry,
 * so anything missed while the socket was down shows up.
 */
async function reloadNotificationHistory(): Promise<void> {
  refreshMessages.disabled = true;
  resetNotificationList();

  try {
    await Promise.all([loadNotificationHistory(), refreshMetrics()]);
  } finally {
    refreshMessages.disabled = false;
  }
}

function disarmClear(): void {
  const wasArmed = clearMessages.dataset.armed === "true";
  window.clearTimeout(clearArmTimer);
  clearArmTimer = undefined;
  clearMessages.removeAttribute("data-armed");
  restoreClearMessagesIcon();
  clearMessages.setAttribute("aria-label", "Delete all notifications");
  clearMessages.title = "Delete all notifications";
  cancelClear.hidden = true;
  if (wasArmed) {
    // Take back the warning the arming put there; nothing was deleted.
    setHistoryStatus(lastRetentionDays);
  }
}

function armClear(): void {
  clearMessages.dataset.armed = "true";
  clearMessages.textContent = "Confirm";
  clearMessages.setAttribute("aria-label", "Confirm deleting all notifications");
  clearMessages.title = "Confirm deleting all notifications";
  cancelClear.hidden = false;
  messagesStatus.textContent =
    "This deletes every notification for good. Counts are kept. Click Confirm to continue.";
  messagesStatus.classList.remove("error");
  window.clearTimeout(clearArmTimer);
  clearArmTimer = window.setTimeout(disarmClear, CYCLE_ARM_TIMEOUT_MS);
}

/** Deletes the caller's stored notifications; the metrics are left alone. */
async function clearNotificationHistory(): Promise<void> {
  disarmClear();
  clearBusy = true;
  clearMessages.disabled = true;
  refreshMessages.disabled = true;
  messagesStatus.textContent = "Deleting notifications...";
  messagesStatus.classList.remove("error");

  try {
    const response = await fetch("/api/notifications", {
      method: "DELETE",
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
          : `delete request failed (${response.status})`,
        response.status,
      );
    }
    // Reloading rather than just emptying the list confirms the server agrees,
    // and restores the retention note the status line normally carries.
    resetNotificationList();
    trackEvent(CLARITY_EVENTS.historyCleared);
    await loadNotificationHistory();
  } catch (error) {
    setHistoryError(error, true);
  } finally {
    clearBusy = false;
    clearMessages.disabled = false;
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
    // Server-held counters become session dimensions, so a recording can be
    // read as "a daily driver" or "someone who has never sent anything" rather
    // than as an anonymous page view.
    if (typeof body.total === "number") {
      tagSession(
        CLARITY_TAGS.notificationVolume,
        bucket(body.total, VOLUME_BUCKETS),
      );
    }
    if (typeof body.last24Hours === "number") {
      tagSession(
        CLARITY_TAGS.activity24h,
        bucket(body.last24Hours, ACTIVITY_BUCKETS),
      );
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

async function fetchApiKey(
  path: string,
  method: "GET" | "POST",
): Promise<ApiKeyResponse> {
  const response = await fetch(path, {
    method,
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
        : `API key request failed (${response.status})`,
      response.status,
    );
  }
  const body = (await response.json()) as Partial<ApiKeyResponse>;
  if (typeof body.apiKey !== "string" || typeof body.maskedKey !== "string") {
    throw new Error("server returned an invalid API key");
  }
  return { apiKey: body.apiKey, maskedKey: body.maskedKey };
}

/** Shows the mask, keeping the full key out of the DOM but ready to copy. */
function renderApiKey(key: ApiKeyResponse): void {
  currentApiKey = key.apiKey;
  apiKeyValue.value = key.maskedKey;
}

function setApiKeyStatus(message: string, isError = false): void {
  apiKeyStatus.textContent = message;
  apiKeyStatus.classList.toggle("error", isError);
}

function setApiKeyError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  apiKeyStatus.replaceChildren(`${context}: ${detail} `);
  apiKeyStatus.classList.add("error");
  if (
    error instanceof SessionAwareError &&
    error.status === 401
  ) {
    const signIn = document.createElement("a");
    signIn.href = "/.auth/login/aad?post_login_redirect_uri=/";
    signIn.textContent = "Sign in again";
    apiKeyStatus.append(signIn);
  }
}

async function loadApiKey(): Promise<void> {
  const generation = (apiKeyGeneration += 1);
  try {
    const key = await fetchApiKey("/api/apikey", "GET");
    if (generation !== apiKeyGeneration) {
      return;
    }
    renderApiKey(key);
    setApiKeyStatus("");
  } catch (error) {
    if (generation === apiKeyGeneration) {
      setApiKeyError("Unable to load the API key", error);
    }
  }
}

function showCopyFeedback(message: string, isError = false): void {
  setApiKeyStatus(message, isError);
  window.clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = window.setTimeout(() => setApiKeyStatus(""), 2000);
}

/** iOS and older Safari lack or reject navigator.clipboard, so fall back to a
 * temporary textarea. The write stays inside the click gesture either way. */
function copyWithExecCommand(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    const copied = document.execCommand("copy");
    showCopyFeedback(copied ? "Copied" : "Copy failed", !copied);
  } catch {
    showCopyFeedback("Copy failed", true);
  } finally {
    textarea.remove();
  }
}

function copyApiKeyToClipboard(): void {
  const key = currentApiKey;
  if (!key) {
    return;
  }
  // Never await before writeText: iOS discards the clipboard write once the
  // synchronous user gesture ends, so the full key is copied straight away.
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(key).then(
      () => showCopyFeedback("Copied"),
      () => copyWithExecCommand(key),
    );
    trackEvent(CLARITY_EVENTS.apiKeyCopied);
    return;
  }
  copyWithExecCommand(key);
  trackEvent(CLARITY_EVENTS.apiKeyCopied);
}

async function apiKeyForTestNotification(): Promise<string> {
  if (currentApiKey) {
    return currentApiKey;
  }
  showTestNotificationProgress(
    "Loading API key before sending test notification...",
  );
  const key = await fetchApiKey("/api/apikey", "GET");
  renderApiKey(key);
  setApiKeyStatus("");
  return key.apiKey;
}

async function sendTestNotification(): Promise<void> {
  if (testNotificationBusy) {
    return;
  }
  testNotificationBusy = true;
  try {
    const apiKey = await apiKeyForTestNotification();
    showTestNotificationProgress("Sending test notification...");
    const response = await fetch("/api/notify", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        // Otherwise the app's own test sends would be counted as CLI traffic.
        [NOTIFICATION_SOURCE_HEADER]: "web",
      },
      body: JSON.stringify({ message: TEST_NOTIFICATION_MESSAGE }),
      cache: "no-store",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      throw new SessionAwareError(
        typeof body?.error === "string"
          ? body.error
          : `notification request failed (${response.status})`,
        response.status,
      );
    }
    showTransientTestNotificationStatus(TEST_NOTIFICATION_SUCCESS);
    trackEvent(CLARITY_EVENTS.testNotificationSent);
  } catch (error) {
    setTestNotificationError("Unable to send test notification", error);
  } finally {
    testNotificationBusy = false;
  }
}

function disarmCycle(): void {
  window.clearTimeout(cycleArmTimer);
  cycleArmTimer = undefined;
  cycleApiKey.removeAttribute("data-armed");
  cycleApiKey.textContent = "🔄";
  cycleApiKey.setAttribute("aria-label", "Regenerate API key");
  cycleApiKey.title = "Regenerate API key";
}

function armCycle(): void {
  cycleApiKey.dataset.armed = "true";
  cycleApiKey.textContent = "Confirm";
  cycleApiKey.setAttribute("aria-label", "Confirm API key regeneration");
  cycleApiKey.title = "Confirm API key regeneration";
  setApiKeyStatus(
    "Regenerating breaks every configured CLI and MCP client. Click Confirm to continue.",
  );
  window.clearTimeout(cycleArmTimer);
  cycleArmTimer = window.setTimeout(disarmCycle, CYCLE_ARM_TIMEOUT_MS);
}

async function cycleApiKeyValue(): Promise<void> {
  disarmCycle();
  apiKeyCycleBusy = true;
  cycleApiKey.disabled = true;
  copyApiKey.disabled = true;
  const generation = (apiKeyGeneration += 1);
  setApiKeyStatus("Regenerating API key...");
  try {
    const key = await fetchApiKey("/api/apikey/cycle", "POST");
    if (generation !== apiKeyGeneration) {
      return;
    }
    renderApiKey(key);
    setApiKeyStatus("API key regenerated");
    trackEvent(CLARITY_EVENTS.apiKeyCycled);
  } catch (error) {
    if (generation === apiKeyGeneration) {
      setApiKeyError("Unable to regenerate the API key", error);
    }
  } finally {
    apiKeyCycleBusy = false;
    cycleApiKey.disabled = false;
    copyApiKey.disabled = false;
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
    tagSession(CLARITY_TAGS.pushPermission, permission);
    if (permission !== "granted") {
      setPushEnabled(false);
      trackEvent(CLARITY_EVENTS.pushFailed);
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
  tagSession(CLARITY_TAGS.pushSubscribed, String(enabled));
}

function setPushStatus(message: string, isError = false): void {
  pushStatus.textContent = message;
  pushStatus.classList.toggle("error", isError);
}

const pushHelpDialog = requiredElement<HTMLDialogElement>("push-help-dialog");
const pushHelpTitle = requiredElement("push-help-title");
const pushHelpSteps = requiredElement<HTMLOListElement>("push-help-steps");
const pushHelpNote = requiredElement("push-help-note");
const pushHelpClose = requiredElement<HTMLButtonElement>("push-help-close");

/** True when the page runs as an installed / Home Screen web app. */
function isStandaloneDisplay(): boolean {
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }
  // iOS Safari predates display-mode and exposes this legacy flag instead.
  return (navigator as { standalone?: boolean }).standalone === true;
}

function renderPushHelp(): void {
  const guidance = pushHelpGuidance({
    userAgent: navigator.userAgent,
    standalone: isStandaloneDisplay(),
    secureContext: window.isSecureContext,
    // iPadOS Safari reports a Macintosh UA, so touch tells the platforms apart.
    touchPoints: navigator.maxTouchPoints,
  });

  pushHelpTitle.textContent = guidance.title;
  pushHelpSteps.replaceChildren(
    ...guidance.steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    }),
  );
  if (guidance.note) {
    pushHelpNote.textContent = guidance.note;
    pushHelpNote.hidden = false;
  } else {
    pushHelpNote.textContent = "";
    pushHelpNote.hidden = true;
  }
}

function openPushHelp(): void {
  renderPushHelp();
  trackEvent(CLARITY_EVENTS.pushHelpOpened);
  if (typeof pushHelpDialog.showModal === "function") {
    pushHelpDialog.showModal();
    return;
  }
  // Older iOS versions that lack Web Push can also lack <dialog>. Fall back to
  // a plain open panel so the content stays readable and dismissible.
  pushHelpDialog.setAttribute("open", "");
  pushHelpDialog.classList.add("push-help-dialog--fallback-open");
}

function closePushHelp(): void {
  if (typeof pushHelpDialog.close === "function" && pushHelpDialog.open) {
    pushHelpDialog.close();
  } else {
    pushHelpDialog.removeAttribute("open");
  }
  pushHelpDialog.classList.remove("push-help-dialog--fallback-open");
}

pushHelpClose.addEventListener("click", closePushHelp);
// Escape fires a native `cancel` for modal dialogs; keep the fallback class tidy.
pushHelpDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePushHelp();
});
// Clicking the backdrop lands on the dialog element itself, not its body.
pushHelpDialog.addEventListener("click", (event) => {
  if (event.target === pushHelpDialog) {
    closePushHelp();
  }
});
// Escape when the <dialog> fallback (non-modal) is open would not cancel.
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    pushHelpDialog.classList.contains("push-help-dialog--fallback-open")
  ) {
    event.preventDefault();
    closePushHelp();
  }
});

/**
 * Renders the single interactive status: a short, non-wrapping trigger that
 * opens the help dialog. Every "unsupported" call site funnels through here so
 * the wording and the hidden bell toggle stay consistent.
 */
function setPushUnavailable(): void {
  toggleNotifications.hidden = true;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "push-help-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.title = `${PUSH_UNAVAILABLE_LABEL} — tap for help`;
  trigger.textContent = PUSH_UNAVAILABLE_LABEL;
  trigger.addEventListener("click", openPushHelp);
  pushStatus.replaceChildren(trigger);
  pushStatus.classList.add("error");
}

function setPushError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : "Unknown error";
  setPushStatus(`${context}: ${detail}`, true);
  trackEvent(CLARITY_EVENTS.pushFailed);
  if (
    error instanceof SessionAwareError &&
    error.status === 401
  ) {
    // The Microsoft session expired or lost its identity while the page stayed
    // open, so recovering needs a fresh sign-in rather than a retry.
    trackEvent(CLARITY_EVENTS.sessionExpired);
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
    setPushUnavailable();
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
  trackEvent(CLARITY_EVENTS.pushEnabled);
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
    setPushUnavailable();
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
    trackEvent(CLARITY_EVENTS.pushDisabled);
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  }, "Unable to fully disable notifications");
}

function applyServiceWorkerUpdate(worker: ServiceWorker): void {
  connectivity.textContent = "Updating to the latest version...";
  connectivity.hidden = false;
  trackEvent(CLARITY_EVENTS.appUpdated);
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
clearMessages.addEventListener("click", () => {
  if (clearBusy) {
    return;
  }
  if (clearMessages.dataset.armed === "true") {
    void clearNotificationHistory();
  } else {
    armClear();
  }
});
cancelClear.addEventListener("click", disarmClear);
statusDot.addEventListener("click", () => {
  void sendTestNotification();
});
copyApiKey.addEventListener("click", copyApiKeyToClipboard);
cycleApiKey.addEventListener("click", () => {
  if (apiKeyCycleBusy) {
    return;
  }
  if (cycleApiKey.dataset.armed === "true") {
    void cycleApiKeyValue();
  } else {
    armCycle();
  }
});
// A click anywhere else or Escape disarms the pending confirmation.
document.addEventListener("click", (event) => {
  if (cycleApiKey.dataset.armed === "true" && event.target !== cycleApiKey) {
    disarmCycle();
  }
  if (clearMessages.dataset.armed === "true" && event.target !== clearMessages) {
    disarmClear();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (cycleApiKey.dataset.armed === "true") {
    disarmCycle();
  }
  if (clearMessages.dataset.armed === "true") {
    disarmClear();
  }
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
  tagSession(CLARITY_TAGS.installPrompt, "available");
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  installButton.hidden = true;
  tagSession(CLARITY_TAGS.installPrompt, "installed");
  trackEvent(CLARITY_EVENTS.installAccepted);
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) {
    return;
  }
  trackEvent(CLARITY_EVENTS.installPrompted);
  await installPrompt.prompt();
  const choice = await installPrompt.userChoice;
  // `appinstalled` reports acceptance, so only the refusal is recorded here.
  if (choice.outcome === "dismissed") {
    trackEvent(CLARITY_EVENTS.installDismissed);
  }
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
      trackNotificationArrival(
        isNotificationSource(event.data.source)
          ? event.data.source
          : undefined,
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
  setPushUnavailable();
}

/**
 * Analytics starts only once the session is known, so every recording carries
 * the dimensions below from its first frame rather than acquiring them part way
 * through. The project id arrives from application settings by way of the
 * sign-in gate; when it is absent, every call above is inert.
 */
if (
  startTelemetry({
    projectId: document.documentElement.dataset.telemetryProject,
    ...(accountEmail.textContent
      ? { email: accountEmail.textContent }
      : {}),
  })
) {
  tagSession(
    CLARITY_TAGS.appMode,
    isStandaloneDisplay() ? "installed" : "browser",
  );
  tagSession(
    CLARITY_TAGS.platform,
    platformName(navigator.userAgent, navigator.maxTouchPoints),
  );
  tagSession(
    CLARITY_TAGS.theme,
    document.documentElement.dataset.theme ?? "dark",
  );
  tagSession(
    CLARITY_TAGS.pushPermission,
    "Notification" in window ? Notification.permission : "unsupported",
  );
  // Corrected by setPushEnabled once the existing subscription, if any, has
  // been restored; permission granted is not the same as subscribed.
  tagSession(CLARITY_TAGS.pushSubscribed, "false");
  // An installed app never receives `beforeinstallprompt`, and neither does a
  // browser that has no install flow, so the tag is set to the pessimistic
  // value and corrected if the prompt actually arrives.
  tagSession(
    CLARITY_TAGS.installPrompt,
    isStandaloneDisplay() ? "installed" : "unavailable",
  );
}

void connect();
void refreshMetrics();
void loadApiKey();
watchNotificationHistoryPaging();
void loadNotificationHistory();
