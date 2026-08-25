# Notification CLI

Notification CLI publishes messages through Azure Web PubSub. Its companion
Azure Static Web App receives messages in real time and can display browser
notifications. The app also hosts an MCP tool so GitHub Copilot can ask you
to return when a task needs attention.

The design works with the free tiers of Azure Web PubSub and Azure Static Web
Apps. Azure Table Storage keeps browser push subscriptions, and VAPID Web Push
wakes subscribed devices even when the PWA is closed. Secrets stay server-side;
they are never shipped to the browser.

The application runs on either of two interchangeable hosts: the free Static
Web App, or an App Service that additionally acts as an OAuth authorization
server, so MCP clients can authenticate without a copied secret. See
[Hosting](#hosting).

The app is multi-user. Every authorized Microsoft account has its own
notifications, history, metrics and API key, and no account can ever see
another's data. Each account's key is minted automatically the first time it
opens the web app and is managed from the API key section of the frontend.

## Architecture

| Component | Technology | Purpose |
| --- | --- | --- |
| `apps/cli` | Go | Sends notifications through the secured SWA fan-out API |
| `apps/web` | TypeScript and Vite | Installable PWA with live and background notifications |
| `apps/api` | TypeScript and Azure Functions | Authenticates users, stores subscriptions, fans out messages, and hosts MCP |
| `apps/server` | TypeScript and Node.js | App Service host: serves the frontend, the same API, and the OAuth authorization server |
| `infra` | Bicep | Declares the Azure resources and both hosts' settings |
| `installer` | WiX Toolset | Builds the Windows x64 and ARM64 MSIs |

All senders and receivers use the Web PubSub hub named `notifications`.

> **Operators:** Azure Web PubSub Free (`F1`) allows only 20 concurrent
> connections in total. With the multi-user model this budget is shared across
> all users rather than one, and each open browser tab and installed PWA holds
> one connection.

## Hosting

The same application runs on two interchangeable hosts. Both serve the same
frontend and the same API, from the same Web PubSub instance and the same
storage account, so a user's notifications, history, metrics and API key are
identical whichever host they reach.

| | Static Web App (Free) | App Service (B1) |
| --- | --- | --- |
| Cost | Free | Billed hourly |
| Sign-in | Built-in Entra provider | Implemented in `apps/server` |
| API key authentication | Yes | Yes |
| OAuth for MCP clients | **No** | **Yes** |

The split exists for one reason: the Model Context Protocol requires clients to
present `Authorization: Bearer <token>`, and Static Web Apps replaces that
header with its own platform token before a managed function is invoked. No API
change can work around it. The App Service host terminates requests itself, so
the header arrives intact and the OAuth authorization server described below
becomes possible.

The API is defined once, in `packages/core`, as a table of routes. Each host is
a thin adapter over that table, so the two cannot drift apart.

### Deploy the App Service host

1. **Register an Entra application** — this cannot be expressed in Bicep.

   ```powershell
   az ad app create --display-name "Notification CLI" `
     --sign-in-audience AzureADandPersonalMicrosoftAccount `
     --web-redirect-uris "https://<your-app-service-host>/.auth/login/aad/callback"
   az ad app credential reset --id <app-id> --append
   ```

   Record the application ID, the tenant ID and the generated secret. Personal
   Microsoft accounts need the multi-tenant audience above.

2. **Store the deployment configuration** as repository variables
   `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, and repository secrets
   `ENTRA_CLIENT_SECRET` and `SESSION_SECRET`.

   The session secret is the HMAC key that signs the sign-in cookie and the
   cookie carrying the OAuth `state` and PKCE verifier, so it is what stops
   either from being forged. Generate 32 random bytes — there is nothing to
   look up, and no format to match:

   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   ```

   ```bash
   openssl rand -base64 32
   ```

   Use a cryptographic generator, not a passphrase or `Get-Random`: the
   cookie's resistance to forgery is exactly the entropy of this value. Keep
   one value per deployment — every instance of a site must share it, changing
   it signs every browser out, and the Static Web App does not use it at all.

3. **Provision** by running the infrastructure workflow with
   *deploy_app_service* enabled. It creates `<name_prefix>-wa`. Nothing can be
   published before this step: an unprovisioned site fails the deploy workflow
   with `Publish profile is invalid`.

4. **Publish** by setting the repository variable `AZURE_APP_SERVICE_NAME` to
   the site name reported by that run, and storing the site's publish profile
   as the secret `AZURE_APP_SERVICE_PUBLISH_PROFILE`:

   ```powershell
   az webapp deployment list-publishing-profiles `
     --name <site> --resource-group notification-cli --xml
   ```

   The profile is only issued while SCM basic authentication is enabled, which
   Azure turns off by default on new sites. Turn it back on, or the command
   returns nothing:

   ```powershell
   az resource update --resource-group notification-cli `
     --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies `
     --name scm --parent sites/<site> --set properties.allow=true
   ```

   `AZURE_APP_SERVICE_NAME` must equal the `msdeploySite` attribute inside that
   XML, which is the site's own name without any domain suffix. The deploy
   action reports every mismatch as `Publish profile is invalid for app-name
   and slot-name provided`, so the workflow checks the profile first and names
   the real problem.

   Only **SCM** basic authentication is needed; FTP basic authentication can
   stay off. Re-download the profile after enabling it, because one downloaded
   while it was off carries an empty `userPWD`.

   The deploy workflow skips the App Service step entirely while
   `AZURE_APP_SERVICE_NAME` is empty.

5. **Add a custom domain and certificate**, if you use one. App Service issues
   a free managed certificate on B1, but only after the hostname is bound:

   ```powershell
   az webapp config hostname add --webapp-name <site> `
     --resource-group notification-cli --hostname <notify.example.com>
   az webapp config ssl create --resource-group notification-cli `
     --name <site> --hostname <notify.example.com>
   az webapp config ssl bind --resource-group notification-cli `
     --name <site> --certificate-thumbprint <thumbprint> --ssl-type SNI
   ```

   Add the same host to the Entra application's redirect URIs. Access tokens
   are bound to the origin that issued them, so pick one origin and use it
   everywhere.

### If you created the site by hand

The Bicep template configures everything below. A site created in the portal
has none of it, and shows two symptoms in turn:

- **Azure's welcome page.** The platform found no entry point. The deployed
  package declares `main` and an `npm start` script, so this only happens if
  something other than `pnpm package` produced the payload. No startup command
  is needed; setting one to `node dist/main.js` also works.
- **`503` naming a setting.** The application is running and telling you which
  application setting is missing. Set them all in one go:

  ```powershell
  az webapp config appsettings set --name <site> --resource-group <group> --settings `
    NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING="<connection string>" `
    NOTIFICATION_CLI_STORAGE_CONNECTION_STRING="<connection string>" `
    AUTHORIZED_USERS="you@example.com" `
    NOTIFICATION_CLI_ENTRA_TENANT_ID="<tenant>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_ID="<client>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_SECRET="<secret>" `
    NOTIFICATION_CLI_SESSION_SECRET="<32 random bytes, base64>"
  ```

  Point the two connection strings at the **same** Web PubSub instance and
  storage account the Static Web App uses. That is what makes the two hosts
  interchangeable rather than two separate deployments.

Do **not** enable App Service Easy Auth. It rejects any `Authorization` bearer
it cannot validate with a `401`, even on excluded paths, which would break MCP
before the application ever sees the request. Sign-in is implemented in
`apps/server` for exactly that reason, and it re-encodes the signed-in identity
into the same `x-ms-client-principal` header Static Web Apps injects, so the
API and the frontend cannot tell the two hosts apart.

## Prerequisites

- Go 1.24 or newer
- Node.js 22
- pnpm 10.34.5
- An Azure subscription. `infra\main.bicep` creates the Web PubSub instance,
  the Static Web App and the storage account holding the `PushSubscriptions`,
  `NotificationHistory`, `NotificationMetrics` and `ApiKeys` tables.

## Build the CLI

From `apps\cli`, run:

```powershell
$version = (Get-Date).ToUniversalTime().ToString("yyyyMMdd.HHmmss")
go test ./...
go build -trimpath -ldflags "-s -w -X main.version=$version" -o notify.exe .
.\notify.exe --version
```

The output has the requested build-timestamp version:

```text
Notification CLI v20260823.113928 - (C) Luc Vo Van, 2026 - Built with AI
```

Windows on ARM is built from the same x64 machine by setting `GOARCH`:

```powershell
$env:GOOS = "windows"; $env:GOARCH = "arm64"
go build -trimpath -ldflags "-s -w -X main.version=$version" -o notify-arm64.exe .
Remove-Item Env:GOOS, Env:GOARCH
```

## Configure the CLI

First obtain your personal API key: sign in to the deployed web app, open the
**API key** section, and copy the key. The key belongs to your account alone.

Then run:

```powershell
notify --configure
```

The CLI asks for the two settings interactively — no environment variables are
involved, and the key never appears on the command line or in your shell
history:

```text
Service URL: https://<your-static-web-app>.azurestaticapps.net ✔
API key: ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●● ✔
```

Both answers are validated as you type, and a prompt refuses to submit until
its answer is usable. The URL must be absolute and use HTTPS (HTTP is allowed
only for localhost), and the API key must start with `ncli_`. The key is
masked, and a previously saved one is never shown back; the current URL is
offered as an editable default, so re-configuring is mostly a matter of
pressing Enter. Press Ctrl+C to cancel without changing anything.

`--configure` then tests the endpoint before it saves anything, and reports the
outcome:

```text
Testing https://<your-static-web-app>.azurestaticapps.net/api/whoami
Result:  SUCCESS
Account: you@example.com
Saved:   C:\Users\you\AppData\Local\Notification CLI\config.json
Export:  NOTIFICATION_CLI_API_URL and NOTIFICATION_CLI_API_KEY -> user environment (restart open terminals to pick it up)
```

The final step publishes the same two settings to your **user** environment,
purely so MCP clients — which have no configuration file of their own — can
pick them up. On Windows they are written to `HKCU\Environment` and broadcast
so newly launched programs see them; on macOS and Linux a marked block is
rewritten in your login shell profile (`~/.zprofile`, `~/.bash_profile` or
`~/.profile`). The CLI itself never reads them back. If the export fails the
line reads `Export:  FAILED (…)`, which is a warning only — the configuration
is already saved and the CLI works.

The account line is informational — a service that does not report one still
counts as a working configuration and prints
`Account: not reported by the service`. A failing test prints
`Result:  FAILED` with the reason, exits non-zero, and writes nothing. On
Windows the configuration lives in `%LOCALAPPDATA%\Notification CLI\config.json`;
on macOS and Linux it is under the operating system's user configuration
directory.

Because the prompts need somewhere to ask, `--configure` requires an
interactive terminal and refuses to run from a pipe or an unattended script.
Sending notifications does not: only the saved configuration is read.

Cycling the key from the web app's API key section invalidates the old key
immediately, so afterwards you must re-run `notify --configure` and update
every MCP client that used it. Removing your address from `AUTHORIZED_USERS`
revokes your key just as immediately.

The CLI sends through `/api/notify`, allowing the server to resolve the key to
your account and fan out each message to your active Web PubSub clients and
closed subscribed PWAs.

## Send a notification

```powershell
notify Your build has finished
notify "Please return to approve the deployment"
```

## Build the web application and API

```powershell
npm install --global pnpm@10.34.5
pnpm install
pnpm check
pnpm test
pnpm build
pnpm package
pnpm smoke:package
```

Deployable artifacts are written to `dist`: `dist\web` and `dist\api` for the
Static Web App, and `dist\server` for the App Service host. The deployed
`staticwebapp.config.json` declares the prebuilt Functions runtime as
`node:22`, which is required when `skip_api_build` is enabled.

To run the App Service host locally, serve `dist\server` with the four sign-in
settings from the hosting section in the environment:

```powershell
cd dist\server
$env:NOTIFICATION_CLI_ENTRA_TENANT_ID = "<tenant>"
$env:NOTIFICATION_CLI_ENTRA_CLIENT_ID = "<client>"
$env:NOTIFICATION_CLI_ENTRA_CLIENT_SECRET = "<secret>"
$env:NOTIFICATION_CLI_SESSION_SECRET = "<32 random bytes, base64>"
node dist\main.js
```

## Provision Azure resources

`infra\main.bicep` declares the whole solution on free tiers: a Web PubSub
instance (`Free_F1`), a `Standard_LRS` storage account with the five tables,
and a Free-tier Static Web App. It optionally adds the B1 App Service host as
well. It also writes both hosts' application settings, deriving the Web PubSub
and storage connection strings from the resources it just created, so neither
is ever copied by hand.

The template does not deploy application code. Provision first, then run the
deploy workflow.

### Run it from GitHub Actions

**Provision Notification CLI infrastructure** is manual-only, because
infrastructure changes are rare and create billable resources. Start it from
the Actions tab and choose:

| Input | Meaning |
| --- | --- |
| `mode` | `what-if` prints the changes without applying them, `deploy` applies them |
| `resource_group` | Target resource group. Created automatically in `deploy` mode |
| `location` | One of the five regions offering the Static Web Apps Free tier |
| `name_prefix` | Prefix for the generated resource names |
| `custom_domain` | Optional. The DNS record must already resolve to the Static Web App |

`what-if` requires the resource group to exist, because a preview must not
change anything. Run `deploy` first, or create the group by hand.

The workflow signs in with OpenID Connect, so no publishing profile or client
secret is stored. Register a federated credential on an app registration with
the Contributor role over the resource group, then set:

| Repository secret | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of the app registration |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |
| `VAPID_PUBLIC_KEY` | Web Push public key. Leave unset to deploy without push |
| `VAPID_PRIVATE_KEY` | Web Push private key |

| Repository variable | Purpose |
| --- | --- |
| `AUTHORIZED_USERS` | Semicolon-separated Microsoft account email addresses |
| `VAPID_SUBJECT` | Contact URI such as `mailto:you@example.com` |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Defaults to `7` |

Deployment tokens are never printed. After a successful `deploy`, the run
summary shows the command that reads the token so it can be stored as the
`AZURE_STATIC_WEB_APPS_API_TOKEN` secret used by the deploy workflow:

```powershell
az staticwebapp secrets list --name notification-cli-swa `
  --query properties.apiKey --output tsv
```

### Run it locally

```powershell
az deployment group create `
  --resource-group notification-cli `
  --template-file infra\main.bicep `
  --parameters authorizedUsers="you@example.com"
```

Because the settings resource replaces the entire collection, a setting added
by hand in the portal disappears on the next deployment. Add new settings to
the template instead.

## Configure Azure

The Bicep template above sets every value in this table on both hosts. Use the
Static Web App's **Environment variables** blade or the App Service's
**Environment variables** blade to inspect them, or to configure a manually
created instance:

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING` | **Required.** Server-side Web PubSub connection used to negotiate browser access and send messages |
| `AUTHORIZED_USERS` | **Required.** Semicolon-separated Microsoft account email addresses allowed to use the browser app. Removing an address revokes that account's API key immediately |
| `NOTIFICATION_CLI_VAPID_PUBLIC_KEY` | Push only. URL-safe VAPID public key returned to authorized browsers |
| `NOTIFICATION_CLI_VAPID_PRIVATE_KEY` | Push only. Secret VAPID private key used only by the API |
| `NOTIFICATION_CLI_VAPID_SUBJECT` | Push only. VAPID contact URI, normally `mailto:you@example.com` |
| `NOTIFICATION_CLI_STORAGE_CONNECTION_STRING` | Azure Storage connection string used for durable push subscriptions, per-user API keys, notification history and metrics |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Whole number of days notifications stay readable in the frontend. Defaults to `7`, maximum `365` |
| `NOTIFICATION_CLI_ENTRA_TENANT_ID` | App Service only. Directory of the Entra application used to sign users in |
| `NOTIFICATION_CLI_ENTRA_CLIENT_ID` | App Service only. Application ID of that registration |
| `NOTIFICATION_CLI_ENTRA_CLIENT_SECRET` | App Service only. Client secret of that registration |
| `NOTIFICATION_CLI_SESSION_SECRET` | App Service only. The HMAC key signing the sign-in cookie; generate 32 random bytes as shown in [Hosting](#hosting). Changing it signs every browser out |
| `NOTIFICATION_CLI_WEB_ROOT` | App Service only. Optional path to the frontend files. Defaults to `web` next to the bundle |

Real-time delivery through Web PubSub is the required core transport. The
"push only" settings are an optional enhancement: when any of them is missing,
notifications are still delivered live to open pages and the response reports
`"pushConfigured": false` instead of failing. Missing a **required** setting
makes `/api/notify` answer `503` naming the exact variable, for example
`{"error":"NOTIFICATION_CLI_STORAGE_CONNECTION_STRING is not configured."}`.

Generate a VAPID key pair once and keep it stable. Rotating it requires clients
to create a new browser subscription:

```powershell
pnpm --filter @notification-cli/api exec web-push generate-vapid-keys
```

The frontend calls `/api/negotiate` to receive a short-lived client URL and
then opens a secure WebSocket. It receives only the VAPID public key; the
Web PubSub connection string, VAPID private key, the per-user API keys, and
Storage connection string remain server-side.

The Static Web App uses its Free-tier-compatible built-in Microsoft Entra ID
provider to gate only the PWA frontend. Visiting the page redirects to
`/.auth/login/aad`; no custom identity provider registration or paid role
management is required. The App Service host implements the same three routes
itself and produces the same `x-ms-client-principal` header, so everything
below applies identically to both. All `/api/*` routes remain anonymous at the
routing layer and enforce their own security: `/api/notify` and `/api/mcp`
resolve the presented `x-api-key` to the account that owns it and re-check that
account against the allowlist on every call, while browser session,
negotiation, and push-subscription handlers validate the signed-in principal
and allowlist. Because authorization is re-evaluated per request, removing an
address from `AUTHORIZED_USERS` revokes its API key immediately, with no
separate key management step. Set `AUTHORIZED_USERS` to one or more email
addresses, for example `first.user@example.com;second.user@example.com`.
Comparison ignores case and surrounding whitespace. The API fails closed when
the setting is absent or empty.

After sign-in, `/api/session` confirms whether the Microsoft account is
allowlisted. The page displays sign-in and sign-out links when access cannot be
confirmed. Both `/api/session` and `/api/negotiate` validate the
Static Web Apps `x-ms-client-principal` header server-side, so bypassing the
route configuration does not bypass the email allowlist.

Open the deployed page and select **Enable notifications**. The browser stores
its subscription in Azure Table Storage. After that, notifications can arrive
while the page is closed. On iPhone and iPad, install the PWA on the Home
Screen before enabling notifications; iOS supports Web Push only for installed
web apps.

For local Functions development, copy
`apps\api\local.settings.example.json` to
`apps\api\local.settings.json` and fill in all settings. Local requests to the
browser endpoints also need a representative `x-ms-client-principal` header
because authentication is normally injected by Static Web Apps. Do not commit that
file.

## Notification metrics

Every notification accepted by Web PubSub is recorded in the
`NotificationMetrics` table of the storage account, and the frontend shows how
many were sent in the last 24 hours, 7 days and 30 days, along with the
lifetime total.

Each send writes one row partitioned by UTC day, so the windowed counts need a
single range query over at most 31 day partitions. The lifetime total is a
separate counter entity updated with an ETag precondition, which keeps it
accurate under concurrent sends without ever scanning the whole table.

Metrics are telemetry: if the storage account is unreachable the notification
is still delivered, and the response reports the problem in `delivery.metricError`
rather than failing. Rows older than 30 days are never queried, so they can be
deleted at any time without affecting the total.

## Notification history and retention

Notifications stay readable in the frontend for a week by default, so a message
dismissed too quickly can still be opened again. Set
`NOTIFICATION_CLI_RETENTION_DAYS` to any whole number of days between `1` and
`365` to change the window.

Each notification is stored in the `NotificationHistory` table, partitioned by
the recipient. `GET /api/notifications?limit=<n>&before=<cursor>` returns one page
of retained notifications together with the effective `retentionDays`.
Notifications are newest-first, and `nextCursor` is `null` on the last page.
`limit` is optional, defaults to `5`, and is capped at `50`; invalid values
return `400`. `before` is an optional opaque cursor returned as `nextCursor`.
Clients pass it back unchanged to request notifications strictly older than
that position, and malformed cursors return `400`. Like `/api/metrics`, the
endpoint is gated by Microsoft account authentication and is never reachable
with an API key.

The successful response keeps the same envelope on every page:

```json
{
  "retentionDays": 7,
  "notifications": [
    { "id": "...", "title": "...", "body": "...", "sentAt": 1700000000000 }
  ],
  "nextCursor": "<opaque string>"
}
```

Paging keeps the endpoint bounded. Returning the whole retention window in one
response would make each request slower and more memory-hungry as history
grows. Azure Table Storage returns rows ascending by row key and cannot sort a
table on the server, so each row key embeds the send time subtracted from a
fixed upper bound. Ascending order over those keys *is* newest-first, which
turns both paging and pruning into single range queries inside the caller's
partition.

The frontend initially loads the five newest notifications. An
IntersectionObserver sentinel at the bottom of the list asks for older pages as
the user scrolls, so the page can expose retained history without rendering the
whole retention window at once. Selecting the underlined **NOTIFICATIONS**
heading reloads the list from the newest page.

`DELETE /api/notifications` removes every notification belonging to the
signed-in account and answers `{ "deleted": <count> }`. Like the read endpoint
it is gated by Microsoft account authentication, never reachable with an API
key, and scoped to the caller's own partition. The 🗑️ control on the
notifications heading calls it behind a two-step confirmation: the first click
arms the button, a second within four seconds deletes. A cancel button occupying
exactly the space the trash icon vacated, Escape, or a click anywhere else backs
out.

The sweep is lazy: every accepted send appends the new notification and then
deletes that user's rows that have fallen outside the retention window, so no
timer or extra Azure resource is needed. Listing and pruning share one exact
millisecond cutoff, so a notification is readable if and only if it survives the
sweep.

Metrics are deliberately kept in a separate table and are **not** affected by
either deletion — neither the retention sweep nor an explicit clear. The counts
for the last 7 and 30 days, and the lifetime total,
stay correct even when the notification bodies behind them have been swept
away. Retention is best-effort in the same way metrics are: a storage failure
is reported in `delivery.historyError` and never turns a delivered notification
into a failure.

## Progressive Web App updates

Installed home screen apps update themselves, with no user action and no
"Update available" prompt.

A service worker is only replaced when the browser sees that its **bytes**
changed. Because `service-worker.js` is served verbatim from `apps/web/public`,
every deployment used to ship a byte-identical worker, so the browser discarded
it and installed apps stayed on their original version indefinitely. Content
hashed asset filenames do not help: only the worker's own bytes are compared.

The build therefore stamps a unique identity into the worker. `apps/web/vite.config.ts`
replaces a `__BUILD_ID__` placeholder in `dist/service-worker.js` with the build
timestamp and fails the build if the placeholder is missing. That identity also
names the cache, so activating a new worker deletes every older
`notification-cli-shell-*` cache.

The rest of the flow makes sure a new worker is noticed and applied promptly:

- the registration uses `updateViaCache: "none"`, so the update check is never
  answered from the HTTP cache;
- `staticwebapp.config.json` serves `/`, `/index.html` and `/service-worker.js`
  with `Cache-Control: no-cache`;
- the page checks for updates on `pageshow`, `focus`, `visibilitychange` and
  `online`, plus hourly. iOS home screen apps resume from the back/forward cache
  and frequently skip `visibilitychange`, so several triggers are needed. They
  are throttled to one check per minute because a single resume fires more than
  one of them;
- a waiting worker is told to `SKIP_WAITING` immediately, and the page reloads
  on `controllerchange`.

The worker never caches its own script, which would otherwise let a stale copy
shadow a freshly deployed one.

## Configure the MCP server

The MCP endpoint is:

```text
https://<your-host>/api/mcp
```

It accepts two credentials, and prefers the first:

1. **An OAuth 2.1 access token.** The App Service host runs a full
   authorization server, so a compliant MCP client discovers it, registers
   itself, sends you to Microsoft to sign in, and obtains a token without you
   ever copying a secret.
2. **Your personal API key**, for clients that do not implement OAuth.

### OAuth (default)

Point the client at the endpoint with no credentials at all:

```json
{
  "servers": {
    "notification-cli": {
      "type": "http",
      "url": "https://<your-app-service-host>/api/mcp"
    }
  }
}
```

The unauthenticated request answers `401` with an RFC 9728 challenge naming
the metadata document, and the flow proceeds from there:

| Step | Endpoint |
| --- | --- |
| Protected resource metadata | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp` |
| Authorization server metadata | `/.well-known/oauth-authorization-server` |
| Dynamic client registration | `POST /oauth/register` |
| Authorization and consent | `/oauth/authorize` |
| Token and refresh | `POST /oauth/token` |
| Signing keys | `/oauth/jwks` |

Registration is open, because MCP clients cannot be enrolled in advance. It
grants nothing on its own: a token is only ever issued after you sign in with
your Microsoft account and approve the consent page, and only if your account
is listed in `AUTHORIZED_USERS`. PKCE (S256) is required, authorization codes
live 60 seconds and are single-use, access tokens live one hour, and refresh
tokens rotate on every use.

Tokens are ES256-signed and bound to the deployment that issued them: the
`issuer`, the `mcp` scope and the audience `https://<your-host>/api/mcp` are
all revalidated on every request, so a token minted by another instance is
worthless here.

**OAuth requires the App Service host.** Static Web Apps replaces the
`Authorization` header with its own platform token before a managed function
runs, so bearer tokens can never reach the API there — which is exactly why the
App Service host exists.

### API key (fallback)

Any of these three headers carries the key, and they are equivalent:

```text
x-api-key: <key>
x-authorization: Bearer <key>
Authorization: Bearer <key>
```

Keys are prefixed `ncli_`, which is what lets one `Authorization` header carry
either credential: a bearer value starting with `ncli_` is treated as a key,
anything else as a token. On the Static Web App host, use `x-api-key` or
`x-authorization`, since `Authorization` is consumed by the platform.
`x-api-key` wins if more than one is present.

Copy the key from the API key section of the web app. If you cycle it there,
update every MCP client that used it.

#### VS Code

VS Code resolves `${input:...}` placeholders and prompts once per workspace,
storing the answer in its secret storage. Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "notification-cli": {
      "type": "http",
      "url": "https://<your-host>/api/mcp",
      "headers": {
        "x-api-key": "${input:notification-cli-api-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "notification-cli-api-key",
      "type": "promptString",
      "description": "Notification CLI API key",
      "password": true
    }
  ]
}
```

#### GitHub Copilot CLI

The Copilot CLI does not support `inputs`. It expands `${VARNAME}` (and
`$VARNAME`) in header values from the environment that launched `copilot`.
The `${env:VARNAME}` form used by VS Code is **not** recognized and is sent
verbatim, which the server rejects with `401`. Add to
`~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "notification-cli": {
      "type": "http",
      "tools": ["*"],
      "url": "https://<your-host>/api/mcp",
      "headers": {
        "x-api-key": "${NOTIFICATION_CLI_API_KEY}"
      }
    }
  }
}
```

`NOTIFICATION_CLI_API_KEY` must be set in the environment that launches
`copilot`, otherwise the header is sent empty and the server answers `401`.
This variable belongs to the MCP client, which has no configuration file of its
own; `notify` itself ignores it and reads only what `--configure` saved.
`notify --configure` sets it for you at user scope, so in most cases you only
need to restart the terminal that launches `copilot`. To set it by hand:

```powershell
[Environment]::SetEnvironmentVariable(
  "NOTIFICATION_CLI_API_KEY", "<key>", "User")
```

The server implements stateless Streamable HTTP JSON-RPC and exposes
`send_notification`. The tool accepts a required `message` string of up to
1,000 characters.

### Troubleshooting

`Authentication failed: MCPOAuthError` against the **Static Web App** host
means the client tried OAuth, which that host cannot support. Either move to
the App Service host or supply the key in `x-api-key`.

The same error against the **App Service** host means discovery or the token
exchange failed. Check that the client reached
`/.well-known/oauth-protected-resource` and that the origin it discovered
matches the one it calls: tokens are bound to the issuing origin, so mixing the
generated hostname and a custom domain rejects every token.

On the Static Web App host the `/.well-known/*` paths are deliberately routed
to a plain `404`. They must never reach the authenticated catch-all route,
which would answer with a redirect to the Microsoft sign-in page and fail the
client with `OAuth discovery failed: Failed to parse discovery document`.

Verify the endpoint without sending a notification:

```powershell
curl.exe -s -X POST https://<your-host>/api/mcp `
  -H "x-api-key: $env:NOTIFICATION_CLI_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'
```

## MSI installer

The GitHub Actions workflow builds an executable and an installer for each
Windows architecture on every push to `main` and every manual run:
`notify-x64.exe`, `notify-arm64.exe`, `NotificationCLI-x64.msi` and
`NotificationCLI-arm64.msi`. All four are available from the run's
`NotificationCLI-windows` artifact. Windows on ARM can run the x64 build under
emulation, but the ARM64 installer avoids that.

Each MSI installs the executable as `notify.exe` under Program Files and
appends that directory to the machine-wide `PATH`, which every user account
inherits. Open a new terminal afterwards — running shells keep the copy of the
environment they started with. Uninstalling removes the entry again.

The two installers share an upgrade code, so installing one replaces the other
rather than leaving both on the machine.

To build the installers locally:

```powershell
dotnet tool install --global wix --version 5.0.2
foreach ($architecture in "x64", "arm64") {
  wix build -arch $architecture `
    -d ProductVersion=1.0.1 `
    -d NotifyExecutable="$pwd\apps\cli\notify-$architecture.exe" `
    -o "NotificationCLI-$architecture.msi" `
    installer\NotificationCLI.wxs
}
```

The cabinet holding the executable is embedded in the MSI
(`MediaTemplate EmbedCab="yes"`). Without it WiX writes a separate `cab1.cab`
next to the installer, and the install fails with *Source file not found:
cab1.cab* as soon as the MSI is moved or downloaded on its own.

## macOS installer

The same workflow builds `NotificationCLI-macos.pkg` on a macOS runner and
publishes it, alongside the bare `notify` binary, as the `NotificationCLI-macos`
artifact. The binary is universal: the Intel and Apple silicon builds are joined
with `lipo`, so one package serves both.

The package installs `notify` into `/usr/local/bin`, which is already on the
default macOS `PATH` — that is the equivalent of the MSI's `PATH` entry, with
nothing to add or remove. Open a new terminal afterwards and run
`notify --configure` once per user account.

To build it locally on a Mac:

```bash
version=$(date -u +"%Y%m%d.%H%M%S")
mkdir -p pkgroot
for arch in amd64 arm64; do
  GOOS=darwin GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$version" -o "notify-darwin-$arch" apps/cli
done
lipo -create -output pkgroot/notify notify-darwin-amd64 notify-darwin-arm64
pkgbuild --root pkgroot --identifier dev.lvovan.notificationcli \
  --version 1.0.1 --install-location /usr/local/bin NotificationCLI-macos.pkg
```

The package is unsigned, so the first install needs the right-click **Open**
path or an explicit allow in **System Settings → Privacy & Security**.

## Deploy

Provision the infrastructure first, then add the Static Web App deployment
token to the GitHub repository as the `AZURE_STATIC_WEB_APPS_API_TOKEN` Actions
secret. The workflow in `.github\workflows\deploy.yml` tests and builds the CLI
installer, checks and packages the web application, and deploys the frontend
and API. Unlike the infrastructure workflow it also runs on every push to
`main`.

The same run publishes the App Service host once the `AZURE_APP_SERVICE_NAME`
variable and the `AZURE_APP_SERVICE_PUBLISH_PROFILE` secret exist; the step is
skipped while the variable is empty. Both hosts are therefore always deployed
from the same commit and stay in step.

## Breaking migration for this release

This release converts the app from a single shared key to per-user keys. The
`NotificationHistory` and `NotificationMetrics` schemas changed, and the
`NOTIFICATION_CLI_API_KEY` application setting is gone. Upgrade an existing
deployment in this order:

1. Delete the `NotificationHistory` and `NotificationMetrics` tables in the
   storage account. The code recreates them automatically on next use; their
   schema has changed, so old rows are unusable. Notification counters restart
   at zero.
2. Remove the `NOTIFICATION_CLI_API_KEY` application setting from the Static
   Web App.
3. Deploy.
4. Each user signs in, copies their new personal key from the API key section
   of the UI, then re-runs `notify --configure` and updates their MCP config.

The CLI no longer *reads* `NOTIFICATION_CLI_API_URL` or
`NOTIFICATION_CLI_API_KEY`; the saved configuration is its only source of
settings. It does still *write* both at user scope during `--configure`, purely
for the Copilot CLI MCP client, which has no configuration file of its own. Any
copies you persisted elsewhere — machine-scope variables, shell profiles, CI
settings — are obsolete and should be removed.

## Security

- Never place the Web PubSub connection string in a `VITE_*` variable. Vite
  variables are embedded in browser assets.
- Keep the VAPID private key, the Entra client secret, the session secret and
  the Azure Storage connection string server-side.
- Prefer OAuth over the API key for MCP clients on the App Service host. An
  access token is scoped to `mcp`, bound to this deployment, expires in an
  hour, and never has to be pasted anywhere.
- Treat your personal API key like a password. Cycle it from the web app's API
  key section if it is exposed; the old key stops working immediately, so
  update the CLI configuration and every MCP client that used it. Each key
  guards only its owner's `/api/notify` and `/api/mcp` access, and is
  additionally revoked the moment its account leaves `AUTHORIZED_USERS`.
- Keep `AUTHORIZED_USERS` limited to the Microsoft accounts that should receive
  browser notifications. An authenticated account is not sufficient by itself.
- Keep the local CLI configuration file private to your user account.
- The authenticated negotiate endpoint grants receive-only, short-lived
  access. It does not grant permission to publish messages.
- All `/api/*` routes intentionally remain anonymous at the Static Web Apps
  routing layer. Each handler fails closed unless its endpoint-specific API key
  or authorized browser principal is valid.
- The infrastructure workflow authenticates with OpenID Connect, so no Azure
  credential is stored in the repository, and it never prints the Static Web
  App deployment token.

## License

Copyright (C) Luc Vo Van, 2026.
