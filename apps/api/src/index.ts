import { app } from "@azure/functions";
import {
  handleNegotiateRequest,
  handleSessionRequest,
} from "./browser.js";
import { handleMcpRequest } from "./mcp.js";
import { handleMetricsRequest } from "./metrics.js";
import { handleNotifyRequest } from "./notify.js";
import {
  handleDeletePushSubscription,
  handlePushConfigRequest,
  handleSavePushSubscription,
} from "./push.js";

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

app.http("notify", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "notify",
  handler: (request, context) =>
    handleNotifyRequest(request, undefined, undefined, context),
});
