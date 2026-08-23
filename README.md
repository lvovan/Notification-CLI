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
- An Azure Storage account for the `PushSubscriptions` table

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
| `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING` | Server-side Web PubSub connection used to negotiate browser access and send MCP messages |
| `NOTIFICATION_CLI_API_KEY` | Long random key used only by the Go CLI `/api/notify` endpoint |
| `NOTIFICATION_CLI_MCP_API_KEY` | Separate long random key used only by the `/api/mcp` endpoint |
| `AUTHORIZED_USERS` | Semicolon-separated Microsoft account email addresses allowed to use the browser app |
| `NOTIFICATION_CLI_VAPID_PUBLIC_KEY` | URL-safe VAPID public key returned to authorized browsers |
| `NOTIFICATION_CLI_VAPID_PRIVATE_KEY` | Secret VAPID private key used only by the API |
| `NOTIFICATION_CLI_VAPID_SUBJECT` | VAPID contact URI, normally `mailto:you@example.com` |
| `NOTIFICATION_CLI_PUSH_STORAGE_CONNECTION_STRING` | Azure Storage connection string used for durable push subscriptions |

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
provider. Visiting the page redirects to `/.auth/login/aad`; no custom identity
provider registration or paid role management is required. Set
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

## Configure the MCP server

The MCP endpoint is:

```text
https://<your-static-web-app>.azurestaticapps.net/api/mcp
```

It accepts either the HTTP Bearer authorization scheme or an
`x-api-key: <key>` header. A
GitHub Copilot MCP configuration using bearer authentication looks like:

```json
{
  "mcpServers": {
    "notification-cli": {
      "type": "http",
      "url": "https://<your-static-web-app>.azurestaticapps.net/api/mcp",
      "headers": {
        "Authorization": "Bearer ${input:notification-cli-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "notification-cli-key",
      "type": "promptString",
      "description": "Notification CLI MCP API key",
      "password": true
    }
  ]
}
```

The server implements stateless Streamable HTTP JSON-RPC and exposes
`send_notification`. The tool accepts a required `message` string of up to
1,000 characters.

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
- `/api/mcp` intentionally remains anonymous at the Static Web Apps routing
  layer for non-browser Copilot clients, but every request still requires the
  MCP API key.

## License

Copyright (C) Luc Vo Van, 2026.
