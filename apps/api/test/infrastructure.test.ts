import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { API_KEYS_TABLE } from "@notification-cli/core/api-key-storage";
import {
  VAPID_PRIVATE_KEY_ENV,
  VAPID_PUBLIC_KEY_ENV,
  VAPID_SUBJECT_ENV,
} from "@notification-cli/core/fanout";
import { NOTIFICATION_METRICS_TABLE } from "@notification-cli/core/metrics-storage";
import {
  NOTIFICATION_HISTORY_TABLE,
  RETENTION_DAYS_ENV,
} from "@notification-cli/core/notification-storage";
import { OAUTH_TABLE } from "@notification-cli/core/oauth-storage";
import { PUSH_SUBSCRIPTIONS_TABLE } from "@notification-cli/core/push-storage";
import { STORAGE_CONNECTION_STRING_ENV } from "@notification-cli/core/table-storage";
import { CONNECTION_STRING_ENV } from "@notification-cli/core/web-pubsub";

const templatePath = resolve("../../infra/main.bicep");
const workflowPath = resolve("../../.github/workflows/infrastructure.yml");

test("the template supplies every setting the API reads", async () => {
  const template = await readFile(templatePath, "utf8");

  // Adding a setting to the code without adding it here would deploy an
  // instance that answers 503 for the endpoint that needs it.
  for (const setting of [
    CONNECTION_STRING_ENV,
    STORAGE_CONNECTION_STRING_ENV,
    RETENTION_DAYS_ENV,
    VAPID_PUBLIC_KEY_ENV,
    VAPID_PRIVATE_KEY_ENV,
    VAPID_SUBJECT_ENV,
  ]) {
    assert.ok(
      template.includes(`'${setting}'`),
      `infra/main.bicep does not set ${setting}`,
    );
  }
});

test("the template no longer supplies the removed shared API key setting", async () => {
  const template = await readFile(templatePath, "utf8");

  // Keys are now per-user rows in the ApiKeys table, so the single shared
  // application setting must be gone entirely.
  assert.ok(
    !template.includes("NOTIFICATION_CLI_API_KEY"),
    "infra/main.bicep still references the removed NOTIFICATION_CLI_API_KEY setting",
  );
});

test("the template does not declare an authorized users allowlist", async () => {
  const template = await readFile(templatePath, "utf8");

  assert.ok(
    !template.includes("AUTHORIZED_USERS"),
    "infra/main.bicep still references the removed AUTHORIZED_USERS setting",
  );
});

test("the template declares the tables the storage layer uses", async () => {
  const template = await readFile(templatePath, "utf8");

  for (const table of [
    PUSH_SUBSCRIPTIONS_TABLE,
    NOTIFICATION_METRICS_TABLE,
    NOTIFICATION_HISTORY_TABLE,
    API_KEYS_TABLE,
    OAUTH_TABLE,
  ]) {
    assert.ok(
      template.includes(`'${table}'`),
      `infra/main.bicep does not declare the ${table} table`,
    );
  }
});

test("every resource stays on a free or lowest-cost tier", async () => {
  const template = await readFile(templatePath, "utf8");

  assert.match(template, /name: 'Free_F1'/);
  assert.match(template, /name: 'Free'\s+tier: 'Free'/);
  assert.match(template, /name: 'Standard_LRS'/);
  // The frontend ships its own routing, auth and cache rules.
  assert.match(template, /allowConfigFileUpdates: true/);
});

// The App Service host costs money, so it must never appear unless it was
// explicitly asked for. Both hosts read the same settings, which is what makes
// them interchangeable.
test("the App Service host is optional and shares the API settings", async () => {
  const template = await readFile(templatePath, "utf8");

  assert.match(template, /param deployAppService bool = false/);
  assert.match(template, /serverfarms@[\d-]+' = if \(deployAppService\)/);
  assert.match(template, /sites@[\d-]+' = if \(deployAppService\)/);
  assert.match(template, /appSettings: concat\(sharedSettings, \[/);
  assert.match(
    template,
    /properties: toObject\(sharedSettings, setting => setting\.name, setting => setting\.value\)/,
  );
});

test("provisioning never runs automatically", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  const triggers = workflow.slice(
    workflow.indexOf("\non:"),
    workflow.indexOf("\npermissions:"),
  );
  assert.ok(triggers.includes("workflow_dispatch:"));
  // A push must never create or alter billable resources.
  assert.ok(!triggers.includes("push:"));
  assert.ok(!triggers.includes("schedule:"));
  // OpenID Connect keeps Azure credentials out of the repository.
  assert.match(workflow, /id-token: write/);
  // The deployment token must never be captured into workflow state, where it
  // would leak into logs or later steps.
  const capturesToken =
    /(GITHUB_OUTPUT|GITHUB_ENV)[\s\S]{0,120}apiKey/.test(workflow) ||
    /apiKey[\s\S]{0,120}(GITHUB_OUTPUT|GITHUB_ENV)/.test(workflow);
  assert.ok(!capturesToken, "the deployment token must not be captured");
});
