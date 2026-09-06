import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";
import { API_KEYS_TABLE } from "@notification-cli/core/api-key-storage";
import { PLACEHOLDER_PREFIX } from "@notification-cli/core/configuration";
import { CLARITY_PROJECT_ID_ENV } from "@notification-cli/core/telemetry-log";
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
const settingsModulePath = repoPath("infra", "app-settings.bicep");
const workflowPath = repoPath(".github", "workflows", "infrastructure.yml");
const deployWorkflowPath = repoPath(".github", "workflows", "deploy.yml");

test("the template supplies every setting the API reads", async () => {
  const template = await readFile(templatePath, "utf8");

  // Adding a setting to the code without adding it here would deploy an
  // instance that answers 503 for the endpoint that needs it. Each one appears
  // as an object key, either derived by the template or supplied as an
  // optional parameter.
  for (const setting of [
    CONNECTION_STRING_ENV,
    STORAGE_CONNECTION_STRING_ENV,
    RETENTION_DAYS_ENV,
    VAPID_PUBLIC_KEY_ENV,
    VAPID_PRIVATE_KEY_ENV,
    VAPID_SUBJECT_ENV,
  ]) {
    assert.match(
      template,
      new RegExp(`${setting}:`),
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
  const settingsModule = await readFile(settingsModulePath, "utf8");

  assert.ok(!template.includes("deployAppService"));
  assert.match(template, /serverfarms@[\d-]+' = \{/);
  assert.match(template, /sites@[\d-]+' = \{/);
  assert.match(template, /module appServiceSettings 'app-settings\.bicep'/);
  assert.match(settingsModule, /sites\/config@[\d-]+' = \{[\s\S]*?name: 'appsettings'/);
  assert.match(settingsModule, /properties: settings/);
});

test("reading and writing the settings stay in separate templates", async () => {
  const template = await readFile(templatePath, "utf8");
  const settingsModule = await readFile(settingsModulePath, "utf8");

  // ARM rejects a template in which a resource is built from a list() of its
  // own resource ID: "Circular dependency detected on resource
  // .../config/appsettings". Merging in the deployed settings therefore has to
  // read in one template and write in another. Declaring the settings resource
  // next to the lookup again would fail every deployment, and compiles
  // cleanly, so only this guard catches it.
  assert.match(template, /list\('\$\{deployedSite\.id\}\/config\/appsettings'/);
  assert.ok(
    !template.includes("Microsoft.Web/sites/config"),
    "main.bicep must not declare the settings resource it also reads",
  );
  assert.ok(
    !/list\('/.test(settingsModule),
    "app-settings.bicep must not read the settings resource it writes",
  );
  // The merged settings carry connection strings and signing keys, and module
  // parameters are recorded in the deployment history unless marked secure.
  assert.match(settingsModule, /@secure\(\)\s+param settings object/);
});

test("the Web PubSub instance sets no network rules", async () => {
  const template = await readFile(templatePath, "utf8");

  // The Free tier rejects the property outright: "Free tier doesn't support
  // setting network ACLs". It also does not need it, because the service
  // applies allow-all defaults and leaves them alone on later deployments.
  // what-if wrongly predicts their removal, so this guard exists to stop that
  // prediction being "fixed" back into a failing deployment.
  assert.ok(!template.includes("networkACLs:"));
});

test("re-running the template keeps settings it was not given", async () => {
  const template = await readFile(templatePath, "utf8");

  // The Entra registration, session key, VAPID pair and analytics ID are set
  // once and never stored as CI secrets. If the merge below stopped including
  // the deployed settings, every provisioning run would silently wipe them and
  // sign-in would break.
  assert.match(
    template,
    /var effectiveSettings = union\(placeholderSettings, deployedSettings, derivedSettings, suppliedSettings\)/,
  );
  assert.match(template, /list\('\$\{deployedSite\.id\}\/config\/appsettings'/);

  // A supplied value has to be dropped when empty rather than passed through,
  // otherwise a blank parameter would overwrite a live setting with "".
  for (const parameter of ["entraClientId", "sessionSecret", "clarityProjectId"]) {
    assert.match(
      template,
      new RegExp(`empty\\(${parameter}\\) \\? \\{\\} :`),
      `${parameter} would blank the deployed setting when left empty`,
    );
  }
});

test("every setting an operator must supply is created as a placeholder", async () => {
  const template = await readFile(templatePath, "utf8");

  // A setting that is simply absent is invisible in the App Service
  // configuration blade, so nothing tells the operator it exists. The template
  // writes a described placeholder for each one instead, and the server treats
  // the marker as unset.
  assert.match(
    template,
    new RegExp(`var placeholderPrefix = '${PLACEHOLDER_PREFIX}'`),
    "the template's placeholder marker no longer matches PLACEHOLDER_PREFIX",
  );

  for (const setting of [
    "NOTIFICATION_CLI_ENTRA_TENANT_ID",
    "NOTIFICATION_CLI_ENTRA_CLIENT_ID",
    "NOTIFICATION_CLI_SESSION_SECRET",
    VAPID_PUBLIC_KEY_ENV,
    VAPID_PRIVATE_KEY_ENV,
    VAPID_SUBJECT_ENV,
    CLARITY_PROJECT_ID_ENV,
  ]) {
    assert.match(
      template,
      new RegExp(`${setting}: '\\$\\{placeholderPrefix\\} \\S`),
      `infra/main.bicep creates no described placeholder for ${setting}`,
    );
  }

  // The client secret is genuinely optional: a tenant that forbids secrets by
  // policy signs in with the managed identity, so prompting for one would be
  // advice to do the wrong thing.
  assert.ok(
    !new RegExp(
      `NOTIFICATION_CLI_ENTRA_CLIENT_SECRET: '\\$\\{placeholderPrefix\\}`,
    ).test(template),
    "the optional client secret must not be advertised as something to fill in",
  );

  // Every placeholder is present in the merged settings, so a key-presence
  // check would report each one as configured.
  assert.ok(
    !template.includes("contains(effectiveSettings"),
    "a placeholder makes contains() report an unset setting as configured",
  );
});

test("provisioning regenerates keys that are still placeholders", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  // The workflow generates a session key and a VAPID pair only when the site
  // lacks them. Once the template creates those settings as placeholders, a
  // key-presence test reports them as already set and nothing is ever
  // generated, leaving sign-in and Web Push permanently broken.
  assert.ok(
    !/jq -r --arg k "\$1" 'has\(\$k\)'/.test(workflow),
    "infrastructure.yml treats a placeholder as a configured setting",
  );
  assert.match(workflow, new RegExp(`startswith\\("${PLACEHOLDER_PREFIX}"\\) \\| not`));
});

test("resource names match the deployed stack", async () => {
  const template = await readFile(templatePath, "utf8");

  // These are not cosmetic. A name that does not resolve to the existing
  // resource makes the deployment create a second, empty one: a new storage
  // account would orphan every API key, push subscription and notification.
  assert.match(template, /var appServicePlanName = '\$\{namePrefix\}-asp'/);
  assert.match(template, /var appServiceName = '\$\{namePrefix\}-wa'/);
  assert.match(template, /var webPubSubName = '\$\{namePrefix\}-wps'/);
  assert.match(
    template,
    /param storageAccountName string = take\('\$\{toLower\(replace\(namePrefix, '-', ''\)\)\}sto', 24\)/,
  );
  // A hashed name cannot resolve to the account the tables already live in.
  assert.ok(!template.includes("uniqueString"));
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

test("provisioning does not store application secrets in the repository", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  // Application configuration lives on the site and is read back by the
  // template. Re-introducing these as CI secrets would mean every run could
  // overwrite a working configuration with a stale copy.
  for (const secret of [
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "ENTRA_CLIENT_SECRET",
    "SESSION_SECRET",
  ]) {
    assert.ok(
      !workflow.includes(`secrets.${secret}`),
      `infrastructure.yml still reads the ${secret} repository secret`,
    );
  }

  // Secrets reach the CLI through a file, because process arguments are
  // readable by every other process on the runner.
  assert.match(workflow, /--parameters "@\$PARAMETERS_FILE"/);
});

test("provisioning derives every resource name from the App Service name", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  // A separate name input drifted from AZURE_APP_SERVICE_NAME once already,
  // which pointed provisioning at a stack that did not exist.
  assert.ok(!workflow.includes("name_prefix"));
  assert.match(workflow, /APP_SERVICE_NAME: \$\{\{ vars\.AZURE_APP_SERVICE_NAME \}\}/);
  assert.match(workflow, /prefix="\$\{APP_SERVICE_NAME%-wa\}"/);
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
