import { app } from "@azure/functions";
import {
  handleApiKeyCycleRequest,
  handleApiKeyRequest,
} from "@notification-cli/core/apikey";
import {
  handleNegotiateRequest,
  handleSessionRequest,
} from "@notification-cli/core/browser";
import { handleMcpRequest } from "@notification-cli/core/mcp";
import { handleMetricsRequest } from "@notification-cli/core/metrics";
import { handleNotifyRequest } from "@notification-cli/core/notify";
import {
  handleClearNotificationsRequest,
  handleNotificationsRequest,
} from "@notification-cli/core/notifications";
import {
  handleDeletePushSubscription,
  handlePushConfigRequest,
  handleSavePushSubscription,
} from "@notification-cli/core/push";
import { handleWhoamiRequest } from "@notification-cli/core/whoami";

app.http("negotiate", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "negotiate",
  handler: (request) => handleNegotiateRequest(request),
});

app.http("session", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "session",
  handler: (request) => handleSessionRequest(request),
});

app.http("mcp", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "mcp",
  handler: (request, context) => handleMcpRequest(request, undefined, undefined, context),
});

app.http("push-config", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "push/config",
  handler: (request) => handlePushConfigRequest(request),
});

app.http("push-subscriptions-save", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "push/subscriptions",
  handler: (request) => handleSavePushSubscription(request),
});

app.http("push-subscriptions-delete", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "push/subscriptions",
  handler: (request) => handleDeletePushSubscription(request),
});

app.http("metrics", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "metrics",
  handler: (request) => handleMetricsRequest(request),
});

app.http("notifications", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "notifications",
  handler: (request) => handleNotificationsRequest(request),
});

app.http("notifications-clear", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "notifications",
  handler: (request) => handleClearNotificationsRequest(request),
});

app.http("notify", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "notify",
  handler: (request, context) =>
    handleNotifyRequest(request, undefined, undefined, context),
});

app.http("apikey", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "apikey",
  handler: (request) => handleApiKeyRequest(request),
});

app.http("apikey-cycle", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "apikey/cycle",
  handler: (request) => handleApiKeyCycleRequest(request),
});

app.http("whoami", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "whoami",
  handler: (request) => handleWhoamiRequest(request),
});
