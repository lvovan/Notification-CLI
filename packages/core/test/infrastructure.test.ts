import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
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

const templatePath = repoPath("infra", "main.bicep");
const workflowPath = repoPath(".github", "workflows", "infrastructure.yml");
const deployWorkflowPath = repoPath(".github", "workflows", "deploy.yml");

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
  assert.match(template, /name: 'B1'\s+tier: 'Basic'/);
  assert.match(template, /name: 'Standard_LRS'/);
});

test("the App Service host is always deployed and has the API settings", async () => {
  const template = await readFile(templatePath, "utf8");

  assert.ok(!template.includes("deployAppService"));
  assert.match(template, /serverfarms@[\d-]+' = \{/);
  assert.match(template, /sites@[\d-]+' = \{/);
  assert.match(template, /appSettings: concat\(sharedSettings, \[/);
});

test("the Static Web App resources stay removed", async () => {
  const template = await readFile(templatePath, "utf8");
  const infrastructureWorkflow = await readFile(workflowPath, "utf8");
  const deployWorkflow = await readFile(deployWorkflowPath, "utf8");

  for (const removed of [
    "Microsoft.Web/staticSites",
    "staticWebAppName",
    "staticWebAppHostname",
    "customDomain",
  ]) {
    assert.ok(!template.includes(removed), `infra/main.bicep still contains ${removed}`);
  }

  for (const workflow of [infrastructureWorkflow, deployWorkflow]) {
    assert.ok(!workflow.includes("AZURE_STATIC_WEB_APPS_API_TOKEN"));
    assert.ok(!workflow.includes("Azure/static-web-apps-deploy"));
    assert.ok(!workflow.includes("staticWebAppName"));
    assert.ok(!workflow.includes("staticWebAppHostname"));
    assert.ok(!workflow.includes("customDomain"));
  }
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

test("deploying requires an App Service name", async () => {
  const workflow = await readFile(deployWorkflowPath, "utf8");

  assert.match(
    workflow,
    /::error::AZURE_APP_SERVICE_NAME is empty\. Set it to the App Service site name before deploying\./,
  );
  assert.ok(!workflow.includes("if: ${{ vars.AZURE_APP_SERVICE_NAME != '' }}"));
});
