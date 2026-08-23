# Notification CLI

Notification CLI publishes messages through Azure Web PubSub. Its companion
Azure Static Web App receives messages in real time and can display browser
notifications. The app also hosts a key-protected MCP tool so GitHub Copilot
can ask you to return when a task needs attention.

The design works with the free tiers of Azure Web PubSub and Azure Static Web
Apps. Azure Table Storage keeps browser push subscriptions, and VAPID Web Push
wakes subscribed devices even when the PWA is closed. Secrets are used only by
the Go CLI and server-side Azure Functions; they are never shipped to the
browser.

## Architecture

| Component | Technology | Purpose |
| --- | --- | --- |
| `apps/cli` | Go | Sends notifications through the secured SWA fan-out API |
| `apps/web` | TypeScript and Vite | Installable PWA with live and background notifications |
| `apps/api` | TypeScript and Azure Functions | Authenticates users, stores subscriptions, fans out messages, and hosts MCP |
| `installer` | WiX Toolset | Builds the Windows x64 MSI |

All senders and receivers use the Web PubSub hub named `notifications`.

## Prerequisites

- Go 1.24 or newer
- Node.js 22
- pnpm 10.34.5
- An Azure Web PubSub resource
- An Azure Static Web App
- An Azure Storage account for the `PushSubscriptions`, `NotificationHistory`
  and `NotificationMetrics` tables

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

## Configure the CLI

Set the deployed Static Web App URL and its notification API key in the
environment instead of passing secrets on the command line:

```powershell
$env:NOTIFICATION_CLI_API_URL = "https://<your-static-web-app>.azurestaticapps.net"
$env:NOTIFICATION_CLI_API_KEY = "<notification-api-key>"
notify --configure
Remove-Item Env:NOTIFICATION_CLI_API_URL
Remove-Item Env:NOTIFICATION_CLI_API_KEY
```

`--configure` validates and copies the value to the current user's application
configuration directory. On Windows this is
`%LOCALAPPDATA%\Notification CLI\config.json`; on macOS and Linux it is under
the operating system's user configuration directory.

The two environment variables take precedence over saved configuration when
both are present. The CLI sends through `/api/notify`, allowing the server to
fan out each message to active Web PubSub clients and closed subscribed PWAs.

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

Deployable frontend and API artifacts are written to `dist\web` and
`dist\api`. The deployed `staticwebapp.config.json` declares the prebuilt
Functions runtime as `node:22`, which is required when `skip_api_build` is
enabled.

## Configure Azure

In the Azure portal, open the Static Web App's **Environment variables** and
set:

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING` | **Required.** Server-side Web PubSub connection used to negotiate browser access and send messages |
| `NOTIFICATION_CLI_API_KEY` | **Required.** Long random key used only by the Go CLI `/api/notify` endpoint |
| `NOTIFICATION_CLI_MCP_API_KEY` | **Required.** Separate long random key used only by the `/api/mcp` endpoint |
| `AUTHORIZED_USERS` | **Required.** Semicolon-separated Microsoft account email addresses allowed to use the browser app |
| `NOTIFICATION_CLI_VAPID_PUBLIC_KEY` | Push only. URL-safe VAPID public key returned to authorized browsers |
| `NOTIFICATION_CLI_VAPID_PRIVATE_KEY` | Push only. Secret VAPID private key used only by the API |
| `NOTIFICATION_CLI_VAPID_SUBJECT` | Push only. VAPID contact URI, normally `mailto:you@example.com` |
| `NOTIFICATION_CLI_STORAGE_CONNECTION_STRING` | Azure Storage connection string used for durable push subscriptions, notification history and metrics |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Whole number of days notifications stay readable in the frontend. Defaults to `7`, maximum `365` |

Real-time delivery through Web PubSub is the required core transport. The
"push only" settings are an optional enhancement: when any of them is missing,
notifications are still delivered live to open pages and the response reports
`"pushConfigured": false` instead of failing. Missing a **required** setting
makes `/api/notify` answer `503` naming the exact variable, for example
`{"error":"NOTIFICATION_CLI_API_KEY is not configured."}`.

Generate a VAPID key pair once and keep it stable. Rotating it requires clients
to create a new browser subscription:

```powershell
pnpm --filter @notification-cli/api exec web-push generate-vapid-keys
```

The frontend calls `/api/negotiate` to receive a short-lived client URL and
then opens a secure WebSocket. It receives only the VAPID public key; the
Web PubSub connection string, VAPID private key, API key, and Storage
connection string remain server-side.

The Static Web App uses its Free-tier-compatible built-in Microsoft Entra ID
provider to gate only the PWA frontend. Visiting the page redirects to
`/.auth/login/aad`; no custom identity provider registration or paid role
management is required. All `/api/*` routes remain anonymous at the Static Web
Apps routing layer and enforce their own security: `/api/notify` and `/api/mcp`
use separate API keys, while browser session, negotiation, and push-subscription
handlers validate the signed-in principal and allowlist. Set
`AUTHORIZED_USERS` to one or more email addresses, for example
`first.user@example.com;second.user@example.com`. Comparison ignores case and
surrounding whitespace. The API fails closed when the setting is absent or
empty.

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
UTC day. `GET /api/notifications` returns the retained notifications
newest-first together with the effective `retentionDays`. Like `/api/metrics`,
it is gated by Microsoft account authentication and is never reachable with an
API key.

The sweep is lazy: every accepted send appends the new notification and then
deletes the day partitions that have fallen outside the retention window, so no
timer or extra Azure resource is needed. Retention is day-granular, which keeps
listing and pruning in agreement about exactly which partitions survive.

Metrics are deliberately kept in a separate table and are **not** affected by
this deletion. The counts for the last 7 and 30 days, and the lifetime total,
stay correct even when the notification bodies behind them have been swept
away. Retention is best-effort in the same way metrics are: a storage failure
is reported in `delivery.historyError` and never turns a delivered notification
into a failure.

The frontend's **Clear** button only hides messages in the current page.
Retained notifications reappear after a reload until they age out.

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
https://<your-static-web-app>.azurestaticapps.net/api/mcp
```

It authenticates with an `x-api-key: <key>` header carrying
`NOTIFICATION_CLI_MCP_API_KEY`. The two clients differ in how they supply that
secret, so use the matching example below.

### VS Code

VS Code resolves `${input:...}` placeholders and prompts once per workspace,
storing the answer in its secret storage. Add to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "notification-cli": {
      "type": "http",
      "url": "https://<your-static-web-app>.azurestaticapps.net/api/mcp",
      "headers": {
        "x-api-key": "${input:notification-cli-mcp-api-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "notification-cli-mcp-api-key",
      "type": "promptString",
      "description": "Value of NOTIFICATION_CLI_MCP_API_KEY",
      "password": true
    }
  ]
}
```

### GitHub Copilot CLI

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
      "url": "https://<your-static-web-app>.azurestaticapps.net/api/mcp",
      "headers": {
        "x-api-key": "${NOTIFICATION_CLI_MCP_API_KEY}"
      }
    }
  }
}
```

`NOTIFICATION_CLI_MCP_API_KEY` must be set in the environment that launches
`copilot`, otherwise the header is sent empty and the server answers `401`.
Persist it for future sessions with:

```powershell
[Environment]::SetEnvironmentVariable(
  "NOTIFICATION_CLI_MCP_API_KEY", "<key>", "User")
```

The server implements stateless Streamable HTTP JSON-RPC and exposes
`send_notification`. The tool accepts a required `message` string of up to
1,000 characters.

### Troubleshooting

`Authentication failed: MCPOAuthError` means the client received a `401` and
fell back to OAuth. This server uses no OAuth, so the real cause is a missing
or unexpanded `x-api-key` header — check the placeholder syntax and that the
variable is set in the shell that started the client.

MCP clients probe `/.well-known/oauth-authorization-server/...` and
`/.well-known/oauth-protected-resource/...` before falling back to static
credentials. This server does not use OAuth, so those paths are routed to a
plain `404`. They must never reach the authenticated catch-all route, which
would answer with a redirect to the Microsoft sign-in page and fail the client
with `OAuth discovery failed: Failed to parse discovery document`.

Verify the endpoint without sending a notification:

```powershell
curl.exe -s -X POST https://<your-static-web-app>/api/mcp `
  -H "x-api-key: $env:NOTIFICATION_CLI_MCP_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'
```

## MSI installer

The GitHub Actions workflow builds `notify.exe` and
`NotificationCLI-x64.msi` on every push to `main` and every manual run. Both
files are available from the run's `NotificationCLI-x64` artifact. The MSI
installs the executable to Program Files and adds its directory to the
machine-wide `PATH`.

To build the MSI locally:

```powershell
dotnet tool install --global wix --version 5.0.2
wix build -arch x64 `
  -d ProductVersion=1.0.1 `
  -d NotifyExecutable="$pwd\apps\cli\notify.exe" `
  -o NotificationCLI-x64.msi `
  installer\NotificationCLI.wxs
```

## Deploy

Add the Static Web App deployment token to the GitHub repository as the
`AZURE_STATIC_WEB_APPS_API_TOKEN` Actions secret. The workflow in
`.github\workflows\deploy.yml` tests and builds the CLI installer, checks and
packages the web application, and deploys the frontend and API.

## Security

- Never place the Web PubSub connection string in a `VITE_*` variable. Vite
  variables are embedded in browser assets.
- Keep the VAPID private key and Azure Storage connection string server-side.
- Use a unique, randomly generated MCP API key and rotate it if exposed.
- Use distinct random values for `NOTIFICATION_CLI_API_KEY` and
  `NOTIFICATION_CLI_MCP_API_KEY`; each endpoint rejects the other endpoint's
  key.
- Keep `AUTHORIZED_USERS` limited to the Microsoft accounts that should receive
  browser notifications. An authenticated account is not sufficient by itself.
- Keep the local CLI configuration file private to your user account.
- The authenticated negotiate endpoint grants receive-only, short-lived
  access. It does not grant permission to publish messages.
- All `/api/*` routes intentionally remain anonymous at the Static Web Apps
  routing layer. Each handler fails closed unless its endpoint-specific API key
  or authorized browser principal is valid.

## License

Copyright (C) Luc Vo Van, 2026.
