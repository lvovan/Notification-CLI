# Notification CLI

Notification CLI publishes messages through Azure Web PubSub. Its Azure App
Service host serves the installable web app, the API, the MCP tool and the
OAuth authorization server from one Node process. Browser notifications arrive
in real time while the page is open, and VAPID Web Push wakes subscribed
devices even when the PWA is closed.

The design uses Azure Web PubSub Free (`F1`), Azure Table Storage and a Linux
App Service on the B1 plan. Secrets stay server-side; they are never shipped to
the browser.

The app is multi-user. Every Microsoft account admitted by the Entra
application has its own notifications, history, metrics and API key, and no
account can ever see another's data. Each account's key is minted
automatically the first time it opens the web app and is managed from the API
key section of the frontend.

## Architecture

| Component | Technology | Purpose |
| --- | --- | --- |
| `apps/cli` | Go | Sends notifications through the secured API |
| `apps/web` | TypeScript and Vite | Installable PWA with live and background notifications |
| `apps/server` | TypeScript and Node.js | App Service host: serves the frontend, the API, the MCP server and the OAuth authorization server |
| `packages/core` | TypeScript | Shared route table, authentication, storage, Web PubSub and Web Push logic |
| `infra` | Bicep | Declares the Azure resources and App Service settings |
| `installer` | WiX Toolset | Builds the Windows x64 and ARM64 MSIs |

All senders and receivers use the Web PubSub hub named `notifications`.

> **Operators:** Azure Web PubSub Free (`F1`) allows only 20 concurrent
> connections in total. With the multi-user model this budget is shared across
> all users rather than one, and each open browser tab and installed PWA holds
> one connection.

## Hosting

The application runs as one Linux App Service on the B1 plan. That Node process
serves the built frontend, every `/api/*` route, the MCP endpoint and the OAuth
authorization server. Routing, authentication gating, the navigation fallback
and the global security headers are handled in `apps/server`, with route logic
kept in `packages/core`.

The project previously had a Static Web App host. It was retired because the
Model Context Protocol requires clients to present `Authorization: Bearer
<token>`, and Static Web Apps replaces that header with its own platform token
before a managed function is invoked. No API change can work around that. App
Service terminates requests itself, so the header arrives intact and OAuth for
MCP clients works.

Do **not** enable App Service Easy Auth. It rejects any `Authorization` bearer
it cannot validate with a `401`, even on excluded paths, which would break MCP
before the application ever sees the request. Sign-in is implemented
in-process in `apps/server/src/entra.ts` for exactly that reason.

### Deploy the App Service host

1. **Register an Entra application** — this cannot be expressed in Bicep. See
   [Register the Entra application](#register-the-entra-application) below for
   the walkthrough, including which tenant value to use and why no API
   permissions need configuring.

2. **Store the infrastructure configuration** as repository variables
   `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, and repository secrets
   `ENTRA_CLIENT_SECRET` and `SESSION_SECRET`. `ENTRA_CLIENT_SECRET` may be
   left empty; see the credential options below.

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
   one value per deployment — every instance of a site must share it, and
   changing it signs every browser out.

3. **Provision** by running the infrastructure workflow in `deploy` mode. It
   creates `<name_prefix>-wa` and reports that site name in the run summary.
   Nothing can be published before this step: an unprovisioned site fails the
   deploy workflow with `Publish profile is invalid`.

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

   The deploy workflow fails loudly if either `AZURE_APP_SERVICE_NAME` or
   `AZURE_APP_SERVICE_PUBLISH_PROFILE` is missing.

5. **Add a custom domain and certificate**, if you use one. The infrastructure
   template does not bind App Service hostnames. App Service issues a free
   managed certificate on B1, but only after the hostname is bound:

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

### Register the Entra application

This registration authenticates **browsers only**. MCP clients never touch it:
they obtain tokens from the authorization server this application hosts itself,
or fall back to an API key. So the registration stays deliberately small — no
exposed API, no app roles, no Graph permissions.

1. **Create the registration.** In the portal, *Entra ID → App registrations →
   New registration*. Name it, choose an audience from the table below, and
   under *Redirect URI* select the **Web** platform with:

   ```text
   https://<your-app-service-host>/.auth/login/aad/callback
   ```

   That path is not Easy Auth — `apps/server` implements it in-process. It
   must match byte for byte, including the scheme and the absence of a trailing
   slash. Add one entry per origin you will actually browse to: the
   `*.azurewebsites.net` host, your custom domain, and
   `http://localhost:8080/...` if you run the host locally.

   The CLI equivalent:

   ```powershell
   az ad app create --display-name "Notification CLI" `
     --sign-in-audience AzureADandPersonalMicrosoftAccount `
     --web-redirect-uris "https://<your-app-service-host>/.auth/login/aad/callback"
   ```

2. **Choose the audience, then the matching tenant value.** These two must
   agree; a mismatch is the most common cause of `AADSTS50194` or
   `unauthorized_client` at sign-in. `NOTIFICATION_CLI_ENTRA_TENANT_ID` is used
   verbatim as the authority segment, so it accepts the aliases as well as a
   GUID:

   | Who signs in | Sign-in audience | Tenant value |
   | --- | --- | --- |
   | Only your own directory | `AzureADMyOrg` | the directory (tenant) GUID |
   | Any work or school account | `AzureADMultipleOrgs` | `organizations` |
   | Work, school **and** personal | `AzureADandPersonalMicrosoftAccount` | `common` |
   | Only personal accounts | `PersonalMicrosoftAccount` | `consumers` |

   Personal Microsoft accounts require the multi-tenant audience — with
   `AzureADMyOrg` and a GUID they are rejected before the consent screen. If you
   sign in with `@outlook.com` or `@hotmail.com`, use `common`.

   The Entra application's sign-in audience is the access control for this
   service. Choose it deliberately: `AzureADMyOrg` admits everyone in that one
   directory, while `AzureADandPersonalMicrosoftAccount` admits any Microsoft
   account in the world. There is no application-side setting after sign-in to
   narrow that audience back down, so a broad audience is a broad service.

3. **Decide how the application authenticates itself** — or decide that it does
   not have to. The authorization code is bound to this server by PKCE, so a
   client credential is optional. Three arrangements work, and the first one
   available is used:

   | Arrangement | Registration | Setting |
   | --- | --- | --- |
   | None, PKCE only | public client | leave the secret unset |
   | Federated credential | confidential + managed identity | leave the secret unset |
   | Client secret | confidential | set the secret |

   **No credential** is the simplest and needs nothing on the Azure side. Under
   *Authentication*, add the redirect URI under the **Mobile and desktop
   applications** platform rather than *Web*, and set *Allow public client
   flows* to **Yes**. A redirect URI left under *Web* makes the token endpoint
   demand a credential and answer `AADSTS7000218`, which the callback reports
   verbatim.

   ```powershell
   az ad app update --id <app-id> --is-fallback-public-client true `
     --public-client-redirect-uris "https://<your-app-service-host>/.auth/login/aad/callback"
   ```

   This is the standard model for clients that cannot keep a secret, and it
   holds here because the code is useless without the PKCE verifier, which
   never leaves the server, and because it can only be redeemed at a redirect
   URI you registered.

   **A client secret.** *Certificates & secrets → New client secret*. Copy the
   **Value**, not the Secret ID; it is shown once and cannot be retrieved
   afterwards. Note the expiry — sign-in breaks on that date with a `502` from
   the callback, and the fix is to issue a new secret and update the setting.

   ```powershell
   az ad app credential reset --id <app-id> --append --years 2
   ```

   **A federated credential** keeps the registration confidential without
   storing a secret, for a tenant that blocks secrets by policy but also
   forbids public clients. The site proves its identity with its own managed
   identity, and nothing expires.

   Enable a system-assigned identity on the site — the Bicep does this — and
   register its principal as a federated credential on the application:

   ```powershell
   $principal = az webapp identity assign --name <site> `
     --resource-group notification-cli --query principalId --output tsv

   az ad app federated-credential create --id <app-id> --parameters (@{
     name = "notification-cli-app-service"
     issuer = "https://login.microsoftonline.com/<tenant-guid>/v2.0"
     subject = $principal
     audiences = @("api://AzureADTokenExchange")
   } | ConvertTo-Json -Compress)
   ```

   The issuer must name the directory the **managed identity** lives in, as a
   GUID, even when `NOTIFICATION_CLI_ENTRA_TENANT_ID` is `common` for sign-in:
   one is where the site's identity comes from, the other is who may sign in.
   `az account show --query tenantId` gives it.

   The site then reads a token for `api://AzureADTokenExchange` from the local
   identity endpoint and presents it as a `client_assertion` during the code
   exchange. A rejected assertion surfaces as a `502` quoting Entra ID's own
   description; the cause is almost always a subject that no longer matches the
   principal ID, which changes if the identity is disabled and re-enabled.

   An assertion is only attempted when the site actually has a managed
   identity. Without one, and without a secret, the exchange simply carries no
   credential — so enabling the identity is what switches this on.

4. **Leave API permissions alone.** The sign-in requests `openid profile email`
   and nothing else. These are OpenID Connect scopes, granted by the identity
   platform itself rather than by Microsoft Graph, so the default *User.Read*
   entry the portal adds is unnecessary and can be removed. There is nothing to
   grant admin consent for, which is what keeps this workable on a personal
   tenant.

   The application reads exactly one thing from the resulting ID token: the
   address, taken from `email`, then `preferred_username`, then `upn`. It never
   calls Graph and never stores a token.

5. **Make sure an address comes back.** A work account whose *mail* attribute
   is unset yields no `email` claim; the `preferred_username` fallback normally
   covers it. If sign-in fails with `Entra ID did not return an email address`,
   add `email` under *Token configuration → Add optional claim → ID*.

6. **Record the values** — the application (client) ID and the tenant value
   from the table, as `NOTIFICATION_CLI_ENTRA_CLIENT_ID` and
   `NOTIFICATION_CLI_ENTRA_TENANT_ID`, plus
   `NOTIFICATION_CLI_ENTRA_CLIENT_SECRET` if you chose a secret. Omitting that
   last setting is what selects the federated credential, so an empty value and
   a wrong value fail very differently: the first attempts an assertion, the
   second is rejected by the token endpoint.

The Entra application's sign-in audience is the access control. A successful
sign-in is enough to use the application: a single-tenant `AzureADMyOrg`
registration admits everyone in that tenant, and an
`AzureADandPersonalMicrosoftAccount` registration admits any Microsoft account
in the world. Pick the audience deliberately before exposing the service.

The protocol itself is Microsoft's own [MSAL for
Node](https://www.npmjs.com/package/@azure/msal-node): it builds the authorize
URL, redeems the code and validates the identity token. The application adds
only what MSAL cannot, which is correlating the two legs of the flow across a
stateless process — a signed `ncli_flow` cookie carrying the `state`, the PKCE
verifier and the page to return to. That cookie lives for 30 minutes, so
consent, multi-factor prompts and a password change in the middle of a sign-in
all still land back on a valid flow. Losing it is the one recoverable failure:
the callback then says so plainly and asks for a fresh attempt from the
application root.

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
    NOTIFICATION_CLI_ENTRA_TENANT_ID="<tenant>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_ID="<client>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_SECRET="<secret, or omit entirely>" `
    NOTIFICATION_CLI_SESSION_SECRET="<32 random bytes, base64>"
  ```

  Point the connection strings at the Web PubSub instance and storage account
  backing this deployment. The app creates missing tables on demand, but the
  Bicep template creates them up front so a fresh deployment is immediately
  consistent.

Do **not** enable App Service Easy Auth. It rejects any `Authorization` bearer
it cannot validate with a `401`, even on excluded paths, which would break MCP
before the application ever sees the request. Sign-in is implemented
in-process in `apps/server/src/entra.ts` for exactly that reason.

## Prerequisites

- Go 1.24 or newer
- Node.js 22
- pnpm 10.34.5
- An Azure subscription. `infra\main.bicep` creates the Web PubSub instance,
  the B1 Linux App Service and the storage account holding the
  `PushSubscriptions`, `NotificationHistory`, `NotificationMetrics`,
  `ApiKeys` and `NotificationOAuth` tables.

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
Service URL: https://<your-app-service-host> ✔
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
Testing https://<your-app-service-host>/api/whoami
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
every MCP client that used it. Removing an account from the Entra tenant or
changing the app registration audience does not re-check existing API keys or
OAuth access tokens on their next request. To revoke a user immediately, remove
that user's API key row from storage, or have the user cycle the key from the
web app.

The CLI sends through `/api/notify`, allowing the server to resolve the key to
your account and fan out each message to your active Web PubSub clients and
closed subscribed PWAs.

## Send a notification

```powershell
notify Your build has finished
notify "Please return to approve the deployment"
```

## Build the web application and server

```powershell
npm install --global pnpm@10.34.5
pnpm install
pnpm check
pnpm test
pnpm build
pnpm package
pnpm smoke:package
```

Deployable artifacts are written to `dist`: `dist\web` contains the built
frontend, and `dist\server` contains the App Service package that serves the
frontend, API, MCP server and OAuth authorization server.

To run the App Service host locally, serve `dist\server` with the four sign-in
settings from the hosting section in the environment:

```powershell
cd dist\server
$env:NOTIFICATION_CLI_ENTRA_TENANT_ID = "<tenant>"
$env:NOTIFICATION_CLI_ENTRA_CLIENT_ID = "<client>"
$env:NOTIFICATION_CLI_ENTRA_CLIENT_SECRET = "<secret>"   # omit for a public-client registration
$env:NOTIFICATION_CLI_SESSION_SECRET = "<32 random bytes, base64>"
node dist\main.js
```

## Provision Azure resources

`infra\main.bicep` declares the whole solution: a Web PubSub instance
(`Free_F1`), a `Standard_LRS` storage account with the five tables, and the B1
Linux App Service host. It also writes the App Service application settings,
deriving the Web PubSub and storage connection strings from the resources it
just created, so neither is ever copied by hand.

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
| `location` | Azure region for the resources |
| `name_prefix` | Prefix for the generated resource names |

`what-if` requires the resource group to exist, because a preview must not
change anything. Run `deploy` first, or create the group by hand.

The workflow signs in with OpenID Connect, so no publishing profile or Azure
client secret is stored for provisioning. Register a federated credential on an
app registration with the Contributor role over the resource group, then set:

| Repository secret | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of the app registration |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |
| `VAPID_PUBLIC_KEY` | Web Push public key. Leave unset to deploy without push |
| `VAPID_PRIVATE_KEY` | Web Push private key |
| `ENTRA_CLIENT_SECRET` | Optional client secret for the browser sign-in registration |
| `SESSION_SECRET` | HMAC key for the sign-in and OAuth flow cookies |

| Repository variable | Purpose |
| --- | --- |
| `ENTRA_TENANT_ID` | Tenant value for browser sign-in, such as `common` or a tenant GUID |
| `ENTRA_CLIENT_ID` | Application (client) ID of the browser sign-in registration |
| `VAPID_SUBJECT` | Contact URI such as `mailto:you@example.com` |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Defaults to `7` |

After a successful `deploy`, the run summary reports the App Service name and
hostname. Store the name as the `AZURE_APP_SERVICE_NAME` repository variable,
then download the site's publish profile and store it as the
`AZURE_APP_SERVICE_PUBLISH_PROFILE` repository secret for the deploy workflow.

### Run it locally

```powershell
az deployment group create `
  --resource-group notification-cli `
  --template-file infra\main.bicep `
  --parameters `
    entraTenantId="<tenant>" `
    entraClientId="<client>" `
    sessionSecret="<32 random bytes, base64>"
```

Because the settings resource replaces the entire collection, a setting added
by hand in the portal disappears on the next deployment. Add new settings to
the template instead.

## Configure Azure

The Bicep template above sets every value in this table on the App Service. Use
the App Service's **Environment variables** blade to inspect them, or to
configure a manually created instance:

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING` | **Required.** Server-side Web PubSub connection used to negotiate browser access and send messages |
| `NOTIFICATION_CLI_VAPID_PUBLIC_KEY` | Push only. URL-safe VAPID public key returned to signed-in browsers |
| `NOTIFICATION_CLI_VAPID_PRIVATE_KEY` | Push only. Secret VAPID private key used only by the API |
| `NOTIFICATION_CLI_VAPID_SUBJECT` | Push only. VAPID contact URI, normally `mailto:you@example.com` |
| `NOTIFICATION_CLI_STORAGE_CONNECTION_STRING` | Azure Storage connection string used for durable push subscriptions, per-user API keys, notification history and metrics |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Whole number of days notifications stay readable in the frontend. Defaults to `7`, maximum `365` |
| `NOTIFICATION_CLI_ENTRA_TENANT_ID` | Directory of the Entra application used to sign users in |
| `NOTIFICATION_CLI_ENTRA_CLIENT_ID` | Application ID of that registration |
| `NOTIFICATION_CLI_ENTRA_CLIENT_SECRET` | Client secret of that registration. Optional: unset means a managed-identity assertion, or no credential at all for a public client |
| `NOTIFICATION_CLI_SESSION_SECRET` | The HMAC key signing the sign-in cookie; generate 32 random bytes as shown in [Hosting](#hosting). Changing it signs every browser out |
| `NOTIFICATION_CLI_CLARITY_PROJECT_ID` | Optional. Microsoft Clarity project ID. Unset means no analytics tag is loaded and no third-party origin is allowed. See [Usage analytics](#usage-analytics) |
| `NOTIFICATION_CLI_WEB_ROOT` | Optional path to the frontend files. Defaults to `web` next to the bundle |

Real-time delivery through Web PubSub is the required core transport. The
"push only" settings are an optional enhancement: when any of them is missing,
notifications are still delivered live to open pages and the response reports
`"pushConfigured": false` instead of failing. Missing a **required** setting
makes `/api/notify` answer `503` naming the exact variable, for example
`{"error":"NOTIFICATION_CLI_STORAGE_CONNECTION_STRING is not configured."}`.

Generate a VAPID key pair once and keep it stable. Rotating it requires clients
to create a new browser subscription:

```powershell
pnpm --filter @notification-cli/core exec web-push generate-vapid-keys
```

The frontend calls `/api/negotiate` to receive a short-lived client URL and
then opens a secure WebSocket. It receives only the VAPID public key; the
Web PubSub connection string, VAPID private key, the per-user API keys, and
Storage connection string remain server-side.

Visiting the page redirects unauthenticated users to `/.auth/login/aad`. Those
`/.auth/*` paths are implemented by `apps/server`, not by App Service Easy
Auth, and produce the signed browser session that the API uses for frontend
requests. All `/api/*` routes enforce their own security: `/api/notify` uses
the CLI's `x-api-key`, `/api/mcp` uses OAuth or an API key, and browser
session, negotiation, metrics, history and push-subscription handlers validate
the signed-in Microsoft account. The Entra application registration's audience
decides who can sign in, and therefore who can use the service.

Revocation is no longer an application setting change. An issued API key or
OAuth access token keeps working until it is cycled or expires, even after the
account loses access to the Entra tenant or the registration audience changes.
To cut off a user's API-key access immediately, remove that user's key row from
storage, or have the user cycle the key from the web app.

After sign-in, `/api/session` reports the Microsoft account that the host
accepted. The page displays sign-in and sign-out links when no browser session
is present. Browser requests are either accepted with `200` or rejected with
`401`.

Open the deployed page and select **Enable notifications**. The browser stores
its subscription in Azure Table Storage. After that, notifications can arrive
while the page is closed. On iPhone and iPad, install the PWA on the Home
Screen before enabling notifications; iOS supports Web Push only for installed
web apps.

The connection status dot is also a test button. Hovering it shows
`Click to send a test message`, and clicking or tapping it sends a notification
to your own account.

When the browser cannot do Web Push at all, the status card shows a short
`Notifications unavailable` link instead of the bell. Selecting it opens a help
dialog whose instructions are chosen from the user agent, so an iPhone visitor
is told to add the app to the Home Screen while a desktop visitor is told where
the site's notification permission lives. `apps/web/src/push-help.ts` holds that
mapping as a pure function so every device and browser combination is unit
tested without a browser. Its precedence is deliberate: an insecure origin is
reported first, then the Apple platforms, because iOS restricts Web Push to
installed web apps whatever the browser brand — every iOS browser is WebKit
underneath, so a Chrome or Edge user agent there still needs the Safari answer.

For local App Service development, run `dist\server` as shown in
[Build the web application and server](#build-the-web-application-and-server)
and provide the same application settings in the environment.

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

## Usage analytics

Analytics are optional and off by default. Set `NOTIFICATION_CLI_CLARITY_PROJECT_ID`
to a [Microsoft Clarity](https://clarity.microsoft.com/) project ID to turn them
on; leave it unset and no third-party script is loaded, no third-party origin is
allowed by the Content-Security-Policy, and nothing is collected.

To get a project ID, sign in at [clarity.microsoft.com](https://clarity.microsoft.com/),
create a project for the site's hostname, and open **Settings → Overview**. The
ID is the short lowercase token in the tracking snippet — copy only that token,
not the surrounding script. A value that is not 4–32 lowercase alphanumeric
characters is ignored, so a typo cannot widen the security policy or be
interpolated into a script URL.

### How the two halves fit together

Clarity is a browser product: it has no server-side ingestion API, and its Data
Export API is read-only. A notification, however, is nearly always produced by
something with no browser at all — the CLI or an MCP client. Telemetry is
therefore collected on two channels:

- **The browser** reports what a person did, to Clarity.
- **The server** writes structured events to its own App Service logs, and
  additionally *attributes* every notification to the client that produced it.
  That attribution rides along with the live delivery, so an open page projects
  backend-originated activity into Clarity as it arrives.

The shared vocabulary lives in `packages/core/src/telemetry.ts`, which both
halves import, so a renamed tag cannot silently split the two datasets.

### What is deliberately not collected

- **Message text never leaves the service.** Server events record a message
  *length*, never a body. The notification list and the API-key card are marked
  `data-clarity-mask="true"`, so session replays show their layout but not their
  contents.
- **The account address is never sent to Clarity.** Sessions are correlated with
  a truncated SHA-256 pseudonym of the address, which is stable across visits
  without being readable.
- **No API key reaches the DOM.** Only the server-provided mask is rendered.

### Session dimensions

Clarity segments recordings, heatmaps and funnels by these. Counts are bucketed
rather than exact, because an exact count fragments a segment into as many
values as there are users.

| Tag | Values | What it answers |
| --- | --- | --- |
| `app_mode` | `browser`, `installed` | Is the PWA actually being used as an installed app, or only visited? |
| `platform` | `ios`, `android`, `macos`, `windows`, `other` | Which platforms need attention. iPadOS is detected by touch, since it claims to be a Mac |
| `push_permission` | `granted`, `denied`, `default`, `unsupported` | How many users could receive background notifications |
| `push_subscribed` | `true`, `false` | How many actually did — granting permission is not the same as subscribing |
| `notification_volume` | `0`, `1-9`, `10-49`, `50-199`, `200+` | Newcomer or daily driver |
| `activity_24h` | `0`, `1-4`, `5-19`, `20+` | Whether the account is active right now |
| `connection` | `connected`, `connecting`, `disconnected`, `offline` | Real-time delivery reliability as experienced by the browser |
| `install_prompt` | `available`, `unavailable`, `installed` | How large the installable audience is |
| `theme` | `dark`, `light` | Which colour scheme the UI is actually seen in |
| `last_notification_source` | `cli`, `mcp`, `web` | How this session's traffic was produced |

### Events

| Event | Fired when |
| --- | --- |
| `notification_received` | A notification arrives, live or through the service worker |
| `notification_source_cli` / `_mcp` / `_web` | The same arrival, split by producer, so a funnel can separate MCP traffic from CLI traffic |
| `test_notification_sent` | The status dot is used to send a test message |
| `push_enabled` / `push_disabled` / `push_failed` | Background notifications are turned on, off, or fail to subscribe |
| `push_help_opened` | The "Notifications unavailable" help dialog is opened |
| `api_key_copied` / `api_key_cycled` | The API key is copied or regenerated |
| `history_page_loaded` | An older page of notification history is fetched |
| `history_cleared` | The notification list is emptied |
| `install_prompted` / `install_accepted` / `install_dismissed` | The PWA install flow is offered, accepted, or declined |
| `app_updated` | A new version of the frontend is activated |
| `session_expired` | A request is rejected because the sign-in cookie is no longer valid |
| `connection_lost` | The real-time connection drops |

Useful questions these answer together: what fraction of installs go on to
enable push (`install_accepted` → `push_enabled`); whether MCP or the CLI drives
most traffic (`notification_source_*`); whether iOS users get stuck before
installing (`platform` + `install_prompt`); and whether people who lose the
real-time connection stop coming back (`connection_lost` + `activity_24h`).

### Server events

Written to the App Service log stream as single-line JSON, prefixed with
`notification-cli-telemetry` so they can be filtered out of an undifferentiated
stream:

```
notification-cli-telemetry {"event":"notify.delivered","source":"cli","messageLength":42,"durationMs":118,...}
```

| Event | Fields beyond `event` and `source` |
| --- | --- |
| `notify.delivered` / `mcp.delivered` | `messageLength`, `durationMs`, the Web PubSub and Web Push delivery counts, `metricRecorded`, `historyRecorded`, `historyPruned`, `errorCount` |
| `notify.failed` / `mcp.failed` | The same, for a delivery that was incomplete, or `reason: "misconfigured"` with the `setting` that is missing |
| `notify.rejected` / `mcp.rejected` | `reason`: `unauthorized`, `misconfigured`, `invalid-json` or `invalid-message` |
| `mcp.method` | `method` (`initialize`, `tools/list`, `tools/call`, or a truncated unknown name) and, when it did not succeed, `outcome`: `invalid-params` or `unsupported` |

These are the half of the picture Clarity cannot see, because the caller has no
browser. Query them in the portal's **Log stream**, or with
`az webapp log tail`. To count MCP sends over the last day:

```powershell
az webapp log tail --name <app-name> --resource-group <group> |
  Select-String 'notification-cli-telemetry' |
  Select-String '"event":"mcp.delivered"' |
  Measure-Object
```

### Content-Security-Policy

When a project ID is configured, `https://*.clarity.ms` and `https://c.bing.com`
are added to `default-src`, `script-src` and `img-src`. The tag is injected as an
external script rather than pasted as Clarity's inline quick-start snippet, so
`script-src` never needs `unsafe-inline` and the hash-pinned theme bootstrap stays
protected. `apps/server/test/hosting.test.ts` asserts that the origins appear only
when a valid project ID is set.

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
- `apps/server/src/response.ts` serves `/`, `/index.html` and
  `/service-worker.js` with `Cache-Control: no-cache`;
- the page checks for updates on `pageshow`, `focus`, `visibilitychange` and
  `online`, plus hourly. iOS home screen apps resume from the back/forward cache
  and frequently skip `visibilitychange`, so several triggers are needed. They
  are throttled to one check per minute because a single resume fires more than
  one of them;
- a waiting worker is told to `SKIP_WAITING` immediately, and the page reloads
  on `controllerchange`.

The worker never caches its own script, which would otherwise let a stale copy
shadow a freshly deployed one.

## Home screen icon

The web app is gated: every path outside `/api`, `/oauth`, `/.well-known` and
`/.auth` redirects an anonymous visitor to Microsoft sign-in. The install
metadata is the deliberate exception, listed in `PUBLIC_ASSETS` in
`apps/server/src/server.ts`:

`/manifest.webmanifest`, `/apple-touch-icon.png`, `/icon.svg`, `/icon-192.png`,
`/icon-512.png` and `/icon-maskable-512.png` are served anonymously, without
consulting the session at all.

This is not a convenience. When a browser adds the app to the home screen it
fetches the icon **outside the authenticated browsing context**, with no session
cookie. A gated icon therefore answers with a `302` to the sign-in page, the
platform receives HTML where it expected an image, and it silently falls back to
a generated letter tile — a plain "N" — with no error anywhere. Safari happened
to hide the problem because its own add-to-home-screen flow reuses the browsing
session; Edge for iOS did not, which is why the two disagreed on the same site.

None of these files describe the signed-in user, so publishing them discloses
nothing. Two tests in `apps/server/test/hosting.test.ts` keep this working: one
asserts the assets are reachable anonymously and never answer with HTML, the
other asserts that every icon named in `manifest.webmanifest` and every icon or
manifest `<link>` in `index.html` appears in `PUBLIC_ASSETS`. Adding an icon
without publishing it fails the build rather than shipping a letter tile.

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
your Microsoft account under the Entra application's audience and approve the
consent page. PKCE (S256) is required, authorization codes live 60 seconds and
are single-use, access tokens live one hour, and refresh tokens rotate on every
use.

Tokens are ES256-signed and bound to the deployment that issued them: the
`issuer`, the `mcp` scope and the audience `https://<your-host>/api/mcp` are
all revalidated on every request, so a token minted by another instance is
worthless here.

### API key (fallback)

For clients that do not implement OAuth, send your personal API key in one of
these headers:

```text
x-api-key: <key>
Authorization: Bearer <key>
```

The CLI continues to use `x-api-key`. MCP clients should prefer OAuth when
they support it, or `Authorization: Bearer <key>` when they need an explicit
API-key header. `x-api-key` wins if more than one credential is present.

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
        "Authorization": "Bearer ${input:notification-cli-api-key}"
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
        "Authorization": "Bearer ${NOTIFICATION_CLI_API_KEY}"
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

`Authentication failed: MCPOAuthError` means discovery or the token exchange
failed. Check that the client reached
`/.well-known/oauth-protected-resource` and that the origin it discovered
matches the one it calls: tokens are bound to the issuing origin, so mixing the
generated hostname and a custom domain rejects every token.

Verify the endpoint without sending a notification:

```powershell
curl.exe -s -X POST https://<your-host>/api/mcp `
  -H "Authorization: Bearer $env:NOTIFICATION_CLI_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MSI installer

The GitHub Actions workflow builds an executable and an installer for each
Windows architecture on every push to `main` and every manual run. Download
`NotificationCLI-windows-x64` for Intel or AMD PCs; it contains
`notify-x64.exe` and `NotificationCLI-x64.msi`. Download
`NotificationCLI-windows-arm64` for Windows on ARM devices; it contains
`notify-arm64.exe` and `NotificationCLI-arm64.msi`. Windows on ARM can run the
x64 build under emulation, but the ARM64 installer avoids that.

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

Provision the infrastructure first, then set the repository variable
`AZURE_APP_SERVICE_NAME` and the repository secret
`AZURE_APP_SERVICE_PUBLISH_PROFILE`. The workflow in
`.github\workflows\deploy.yml` tests and builds the CLI installers, checks and
packages the web application, and deploys `dist\server` to App Service. Unlike
the infrastructure workflow it also runs on every push to `main`.

The deploy workflow validates both deployment settings before it calls Azure. A
missing site name, missing profile, empty profile password or profile for the
wrong site fails the run with an explicit error instead of silently skipping the
deployment.

## Breaking migration for this release

This release retires the Static Web App and makes the App Service the only
host. Upgrade an existing deployment in this order:

1. Provision the App Service with the updated infrastructure workflow and
   configure `AZURE_APP_SERVICE_NAME` plus
   `AZURE_APP_SERVICE_PUBLISH_PROFILE` for deployment.
2. Add your production hostname to the App Service manually, bind a managed
   certificate, and add the same origin to the Entra application's redirect
   URIs. The Bicep template no longer binds a custom domain for you.
3. Deploy the application and switch users, CLI configurations and MCP clients
   to the App Service origin.
4. Delete the old Static Web App resource in Azure. Remove its custom-domain
   binding first if Azure blocks deletion or if you want to reuse the hostname.
5. Delete any copied Static Web App deployment token. The
   `AZURE_STATIC_WEB_APPS_API_TOKEN` GitHub secret is no longer used and should
   be removed from the repository.
6. Update every MCP client that used the old `x-authorization` workaround to
   send either OAuth or `Authorization: Bearer <key>`. The CLI continues to use
   `x-api-key`.

If you are also upgrading from the earlier single-shared-key release, complete
these one-time data and access-control steps before deploying:

1. Review the Entra application registration's sign-in audience before
   deploying. Everyone that audience admits can use the deployment. If the
   registration was created with a broad audience because `AUTHORIZED_USERS`
   was expected to do the real gatekeeping, narrow the audience now or
   explicitly accept that exposure before continuing.
2. Delete the `NotificationHistory` and `NotificationMetrics` tables in the
   storage account. The code recreates them automatically on next use; their
   schema changed, so old rows are unusable. Notification counters restart at
   zero.
3. Remove the old `NOTIFICATION_CLI_API_KEY` and `AUTHORIZED_USERS` application
   settings from any manually created site. A Bicep redeploy drops settings it
   manages automatically because the settings resource replaces the whole
   collection.
4. Remove the `AUTHORIZED_USERS` repository variable used by older
   infrastructure workflow versions. Leaving it behind is misleading.
5. Each user signs in, copies their personal key from the API key section of
   the UI, then re-runs `notify --configure` and updates their MCP config.

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
  guards only its owner's `/api/notify` and `/api/mcp` access.
- Choose the Entra application audience as if it were the access-control list,
  because it is. A single-tenant registration admits the whole tenant; a
  work-school-and-personal registration admits any Microsoft account.
- Keep the local CLI configuration file private to your user account.
- The authenticated negotiate endpoint grants receive-only, short-lived
  access. It does not grant permission to publish messages.
- All `/api/*` routes are protected in-process. Each handler fails closed
  unless its endpoint-specific API key, OAuth token or signed-in browser
  principal is valid.
- The infrastructure workflow authenticates with OpenID Connect, so no Azure
  credential is stored in the repository.

## License

Copyright (C) Luc Vo Van, 2026.
