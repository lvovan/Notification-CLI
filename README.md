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

2. **Choose the site name** and store it as the repository variable
   `AZURE_APP_SERVICE_NAME`. Every other resource name derives from it, so it
   must end in `-wa`: a site named `<prefix>-wa` produces the resource group
   `<prefix>-rg`, the plan `<prefix>-asp`, the Web PubSub instance
   `<prefix>-wps` and the storage account `<prefix>sto` (lowercased, hyphens
   removed, truncated to 24 characters). Pass the provisioning workflow's
   `resource_group` input if your group does not follow that rule.

   This is deliberately the same variable the deploy workflow uses. A separate
   name input would be free to drift from it, and pointing provisioning at a
   stack that does not exist creates a second, empty copy of everything rather
   than failing.

3. **Store the remaining configuration** as repository variables
   `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, plus optionally `VAPID_SUBJECT`
   (a `mailto:` address enabling Web Push) and `CLARITY_PROJECT_ID`.

   Application secrets are **not** stored in the repository. The session
   signing key and the VAPID key pair are generated during the first
   provisioning run and kept on the site from then on; see
   [Provision Azure resources](#provision-azure-resources) for how re-runs
   preserve them.

   Provisioning also needs `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
   `AZURE_SUBSCRIPTION_ID` as repository secrets, identifying a federated
   Entra application allowed to deploy into the subscription. Without them,
   run the deployment locally instead — the workflow says so and stops.

4. **Provision** by running the infrastructure workflow in `deploy` mode with
   `first_deployment` ticked, which is what tells it the site does not exist
   yet. Nothing can be published before this step: an unprovisioned site fails
   the deploy workflow with `Publish profile is invalid`.

5. **Publish** by giving the deploy workflow an identity to sign in with.
   Publishing uses OpenID Connect rather than a publish profile, so no
   credential is stored: a profile is basic authentication over SCM, which many
   subscriptions keep switched off, and a profile downloaded while it is off
   carries the literal credential `REDACTED` that fails as an opaque 401.

   Create an app registration, let this repository's `main` branch federate to
   it, and give it rights over the site alone:

   ```powershell
   $app = az ad app create --display-name notification-cli-github-deploy `
     --sign-in-audience AzureADMyOrg --output json | ConvertFrom-Json
   $sp = az ad sp create --id $app.appId --output json | ConvertFrom-Json

   az ad app federated-credential create --id $app.id --parameters (@{
     name = "github-main"
     issuer = "https://token.actions.githubusercontent.com"
     subject = "repo:<owner>/<repo>:ref:refs/heads/main"
     audiences = @("api://AzureADTokenExchange")
   } | ConvertTo-Json -Compress)

   az role assignment create --assignee-object-id $sp.id `
     --assignee-principal-type ServicePrincipal --role "Website Contributor" `
     --scope (az webapp show --name <site> --resource-group <site-without-wa>-rg --query id --output tsv)
   ```

   The `subject` must match the ref being deployed exactly; a mismatch is
   rejected at sign-in, before the site is contacted at all. Deploying from
   another branch needs its own federated credential.

   Some accounts present an **immutable** subject instead, naming the owner and
   repository by numeric ID:

   ```
   repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:refs/heads/main
   ```

   Nothing advertises which form you get, and the failure names the presented
   subject, so read it out of the error and register that too:

   ```
   AADSTS700213: No matching federated identity record found for presented
   assertion subject '...'
   ```

   Both forms can be registered on the same application, which is the simplest
   way to be right either way.

   Then store `AZURE_CLIENT_ID` (the application ID), `AZURE_TENANT_ID` and
   `AZURE_SUBSCRIPTION_ID` as repository secrets, and set the
   `AZURE_APP_SERVICE_NAME` variable to the site name.

   The deploy workflow fails loudly if any of those secrets or the site name
   variable is missing.

6. **Add a custom domain and certificate**, if you use one. The infrastructure
   template does not bind App Service hostnames. App Service issues a free
   managed certificate on B1, but only after the hostname is bound:

   ```powershell
   az webapp config hostname add --webapp-name <site> `
     --resource-group <resource-group> --hostname <notify.example.com>
   az webapp config ssl create --resource-group <resource-group> `
     --name <site> --hostname <notify.example.com>
   az webapp config ssl bind --resource-group <resource-group> `
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
     --resource-group <resource-group> --query principalId --output tsv

   az ad app federated-credential create --id <app-id> --parameters (@{
     name = "notification-cli-app-service"
     issuer = "https://login.microsoftonline.com/<tenant-guid>/v2.0"
     subject = $principal
     audiences = @("api://AzureADTokenExchange")
   } | ConvertTo-Json -Compress)
   ```

   Then set `NOTIFICATION_CLI_ENTRA_USE_MANAGED_IDENTITY` to `true`, or pass
   `entraUseManagedIdentity=true`. Nothing is inferred: App Service always
   exposes an identity endpoint, so a site that guessed from it would send an
   assertion that a public-client registration cannot use, and Entra ID would
   answer `AADSTS70025`.

   The issuer must name the directory the **managed identity** lives in, as a
   GUID, even when `NOTIFICATION_CLI_ENTRA_TENANT_ID` is `common` for sign-in:
   one is where the site's identity comes from, the other is who may sign in.
   `az account show --query tenantId` gives it.

   **The identity and the app registration must share a tenant.** A directory
   commonly refuses any other issuer outright:

   ```
   FederatedIdentityCredential.Issuer value '...' not allowed as per assigned policy
   ```

   Crossing tenants needs a multitenant registration provisioned into the
   identity's directory, which the same class of policy usually also forbids.
   Where the site cannot be moved into the registration's tenant, the
   public-client flow above is the arrangement that works.

   Because the setting survives every redeployment once written, the template
   refuses it rather than trusting it: when `NOTIFICATION_CLI_ENTRA_TENANT_ID`
   is not the subscription's own tenant, `true` is rewritten to `false` and the
   deployment reports `entraManagedIdentityRefused`. It judges the merged
   settings, so a `true` an earlier run left on the site is disarmed too. Read
   it back after provisioning:

   ```powershell
   az deployment group show --resource-group <resource-group> --name <deployment> `
     --query properties.outputs.entraManagedIdentityRefused.value
   ```

   Without that guard the failure is hard to place: sign-in redirects
   correctly, the consent screen appears, and only the token exchange fails —
   with `AADSTS70025`, naming the client rather than the setting that broke it.

   The site then reads a token for `api://AzureADTokenExchange` from the local
   identity endpoint and presents it as a `client_assertion` during the code
   exchange. A rejected assertion surfaces as a `502` quoting Entra ID's own
   description; the cause is almost always a subject that no longer matches the
   principal ID, which changes if the site is deleted and recreated.

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
    NOTIFICATION_CLI_AZURE_WEB_PUBSUB_ENDPOINT="https://<instance>.webpubsub.azure.com" `
    NOTIFICATION_CLI_STORAGE_TABLE_ENDPOINT="https://<account>.table.core.windows.net/" `
    NOTIFICATION_CLI_ENTRA_TENANT_ID="<tenant>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_ID="<client>" `
    NOTIFICATION_CLI_ENTRA_CLIENT_SECRET="<secret, or omit entirely>" `
    NOTIFICATION_CLI_SESSION_SECRET="<32 random bytes, base64>"
  ```

  Both are plain endpoints, not connection strings: the site authenticates with
  its managed identity, so setting them by hand is not enough on its own — the
  identity also needs the role assignments described in
  [Provision Azure resources](#provision-azure-resources). A `403` from
  Storage or Web PubSub means the endpoints are right and the roles are
  missing. The app creates missing tables on demand, but the Bicep template
  creates them up front so a fresh deployment is immediately consistent.

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
Linux App Service host. It also writes the App Service application settings.

No key or connection string is among them. The site is given the two service
endpoints and reaches both with its system-assigned managed identity, which the
template grants **Storage Table Data Contributor** on the storage account and
**Web PubSub Service Owner** on the hub. Shared key access on the storage
account and local auth on Web PubSub are switched off, so the keys those
services still hold cannot be used at all — including by the portal's key-based
table browser.

A connection string bundled two separate things: *which* resource to talk to,
and *proof* that you may. Only the second is gone. The endpoints still name one
specific account and one specific hub, derived by the template from the
resources it just created, so the app is pointed at them as precisely as
before:

```bicep
NOTIFICATION_CLI_AZURE_WEB_PUBSUB_ENDPOINT: 'https://${webPubSub.properties.hostName}'
NOTIFICATION_CLI_STORAGE_TABLE_ENDPOINT: storageAccount.properties.primaryEndpoints.table
```

The proof is fetched per call instead of stored: the identity obtains a
short-lived Entra token scoped to that resource. An endpoint pointing somewhere
the identity holds no role therefore fails with `403` rather than silently
working, and the endpoints themselves are public hostnames, so unlike the
connection strings they replaced there is nothing in them to leak.

Creating those role assignments needs **Owner** or **User Access
Administrator** on the resource group. A Contributor can deploy everything else
and will fail only on that pair. Running locally, the same code signs in as
whoever is logged in to the Azure CLI, so development needs no secret either;
grant your own account the same two roles.

The template does not deploy application code. Provision first, then run the
deploy workflow.

### Run it from GitHub Actions

**Provision Notification CLI infrastructure** is manual-only, because
infrastructure changes are rare and create billable resources. Start it from
the Actions tab and choose:

| Input | Meaning |
| --- | --- |
| `mode` | `what-if` prints the changes without applying them, `deploy` applies them |
| `location` | Azure region. Only used when creating resources; existing ones keep theirs |
| `first_deployment` | Tick only when the App Service site does not exist yet |
| `resource_group` | Optional. Defaults to the site name with `-wa` replaced by `-rg` |

There is no name input. Every resource name derives from the
`AZURE_APP_SERVICE_NAME` repository variable, which must end in `-wa`:

| Variable value | Plan | Web PubSub | Storage | Default group |
| --- | --- | --- | --- | --- |
| `notification-lvovan-wa` | `notification-lvovan-asp` | `notification-lvovan-wps` | `notificationlvovansto` | `notification-lvovan-rg` |

One variable rather than two is a safety property, not a convenience. Resource
names are how a deployment finds what already exists; a name that resolves to
nothing is not an error, it is a brand new resource. A separate input free to
drift from the deploy workflow's variable would provision a second, empty stack
whose storage account holds none of the existing API keys, push subscriptions
or notification history.

The resource group is the exception, and stays an input: it only says where to
look, so getting it wrong fails rather than duplicating anything.

`what-if` requires the resource group to exist, because a preview must not
change anything. Run `deploy` first, or create the group by hand.

#### Settings are preserved, not re-supplied

The template reads the running site's application settings and keeps every
value it was not explicitly given. So the Entra registration, the session
signing key, the VAPID pair and the analytics ID are configured once and
survive every later run, without being stored as repository secrets.

This is why `first_deployment` exists, and why it defaults to off. The two ways
of getting it wrong are not equally bad: claiming the site exists when it does
not fails with a plain "not found", while claiming it does not exist when it
does would silently erase its configuration. The safe answer is the default,
and a first deployment has to say so deliberately.

The first run generates what it cannot be given: a session signing key always,
and a VAPID key pair when `VAPID_SUBJECT` is set. Push services use that
subject to contact the sender, so it is a real address and cannot be invented —
without it the run warns and leaves push off, and notifications reach only open
browser tabs.

The trade-off is that a setting the template no longer knows about is kept
rather than removed. Delete retired settings from the site by hand.

Structural parameters behave differently from settings, because nothing reads
them back off the site: one left unset silently reverts to the template
default. `privateStorageAccess` is therefore passed on every run from the
`NOTIFICATION_CLI_PRIVATE_STORAGE_ACCESS` variable — leaving it unset once
would delete the private endpoint the site reaches storage through and take the
application down.

After deploying, the workflow leaves the site publishable: it grants the deploy
identity **Website Contributor** on the site and registers the federated
credentials that identity signs in with. Untick `authorize_deploy` to skip it.

The workflow signs in with OpenID Connect, so no publishing profile or Azure
client secret is stored for provisioning. Register a federated credential on an
app registration and give it these roles over the resource group:

| Role | Why |
| --- | --- |
| `Contributor` | Creates and updates the resources themselves |
| `User Access Administrator` | The template assigns the site's managed identity its roles on Storage and Web PubSub, and Contributor cannot write role assignments |

Managing the federated credentials also needs the Microsoft Graph application
permission `Application.ReadWrite.OwnedBy`, with the identity added as an owner
of its own registration. That grant needs a directory administrator, so it is
optional: without it the run warns, prints the exact subjects to register, and
carries on rather than failing a good deployment.

Then set:

| Repository secret | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of the app registration |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |

Those three are the only secrets provisioning needs. If they are absent the
workflow stops before signing in and says so, rather than failing later with an
authentication error that names the wrong cause.

| Repository variable | Purpose |
| --- | --- |
| `AZURE_APP_SERVICE_NAME` | **Required.** Site name, ending in `-wa`. Every other resource name derives from it |
| `AZURE_RESOURCE_GROUP` | Resource group. Defaults to the site name with `-wa` replaced by `-rg`, so set it when the group does not follow that convention |
| `NOTIFICATION_CLI_PRIVATE_STORAGE_ACCESS` | `true` to reach Table Storage over a private endpoint. Must stay set, or the next run removes it |
| `ENTRA_TENANT_ID` | Tenant value for browser sign-in, such as `common` or a tenant GUID |
| `ENTRA_CLIENT_ID` | Application (client) ID of the browser sign-in registration |
| `VAPID_SUBJECT` | Contact URI such as `mailto:you@example.com`. Enables Web Push on a first deployment |
| `CLARITY_PROJECT_ID` | Optional. Microsoft Clarity project for [usage analytics](#usage-analytics) |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Defaults to `7` |

The variables above are passed on every run, so changing one takes effect on
the next `deploy`. Leaving one unset is not the same as setting it empty: an
unset variable is simply not passed, and therefore cannot blank the value the
site is already running with.

After a successful `deploy`, the run summary reports the App Service hostname,
the managed identity object ID, whether the deploy workflow was authorized, and
any retired settings still on the site.

### Run it with azd

`azure.yaml` and `infra/main.parameters.json` make the template a first-class
`azd` project, so provisioning is:

```powershell
azd env new prod --subscription <subscription-id> --location westeurope
azd env set AZURE_RESOURCE_GROUP notify-rg
azd env set NOTIFICATION_CLI_NAME_PREFIX notification-lvovan
azd provision
```

`AZURE_RESOURCE_GROUP` is required because the template is scoped to a resource
group rather than a subscription. Every other parameter is optional and reads
from the azd environment, so `azd env set NOTIFICATION_CLI_CLARITY_PROJECT_ID
<id>` configures a value and leaving it unset keeps whatever the site already
has.

`siteExists` looks after itself: it defaults to `false`, and the template
returns `NOTIFICATION_CLI_SITE_EXISTS=true` as an output, which azd writes back
into the environment. A fresh environment therefore provisions as a first
deployment and every run after it reads the deployed settings.

Only provisioning is configured. `azure.yaml` declares no services, because the
application package is built and shipped by the deploy workflow, so `azd deploy`
has nothing to do.

### Run it with the Azure CLI

This is the route that works without any Azure credentials in the repository.
`az` uses your own sign-in:

```powershell
az deployment group create `
  --resource-group notify-rg `
  --template-file infra\main.bicep `
  --parameters namePrefix=notification-lvovan siteExists=false
```

Preview first with `az deployment group what-if` and the same arguments. A
healthy preview of an existing deployment reports `NoChange` for the storage
account, the plan and every table: anything else means the names no longer
resolve to the deployed resources, and applying it would build a parallel,
empty stack.

One difference in that preview is expected and harmless: it reports the Web
PubSub network rules as being removed. The template does not set them because
the Free tier rejects the property outright, and the service keeps its
allow-all defaults across deployments regardless. `what-if` compares the
template against the resource and cannot know that, so it predicts a removal
that never happens.

`az deployment group validate` is the stricter check, because it runs resource
provider preflight and so catches what `what-if` cannot.

### When storage refuses every request

Some subscriptions run a governance policy that forces `publicNetworkAccess` to
`Disabled` on every storage account, and silently reverts any attempt to set it
back — `az storage account update` reports success and the property stays
`Disabled`. The site signs users in normally and then fails every data call:

```
Unable to load metrics: The request could not be completed.
```

Storage answers `AuthorizationFailure` regardless of the roles held, because
network rules are evaluated before RBAC. Check for it with:

```powershell
az storage account show --name <account> --resource-group <resource-group> `
  --query publicNetworkAccess --output tsv
```

Deploy with `privateStorageAccess=true` to route Table Storage over a private
endpoint instead. That adds a virtual network, a private endpoint and a private
DNS zone, joins the site to the network and sends its outbound traffic through
it, so the account's own hostname resolves to a private address. The private
endpoint is billed hourly, so it is off by default.

Service endpoints are not an alternative: they still arrive at the public
endpoint, which is what the policy switches off.

Drop `siteExists=false` once the site exists, and pass any of
`entraTenantId`, `entraClientId`, `entraClientSecret`, `sessionSecret`,
`vapidPublicKey`, `vapidPrivateKey`, `vapidSubject` or `clarityProjectId` to
set them. Omit a parameter to keep whatever the site already has.

The deployment outputs report what was actually written, which is the quickest
way to confirm a setting landed:

```powershell
az deployment group show --resource-group notify-rg --name <deployment-name> `
  --query properties.outputs.{webPubSub:webPubSubEndpoint.value,table:storageTableEndpoint.value,stale:staleSettings.value}
```

`staleSettings` lists retired settings the site still holds. The template merges
over the deployed configuration and so can never delete a key: anything listed
there — the former `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING` and
`NOTIFICATION_CLI_STORAGE_CONNECTION_STRING`, which carried account keys — must
be removed by hand from the **Environment variables** blade.

## Configure Azure

The Bicep template above sets every value in this table on the App Service. Use
the App Service's **Environment variables** blade to inspect them, or to
configure a manually created instance:

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_CLI_AZURE_WEB_PUBSUB_ENDPOINT` | **Required.** `https://<instance>.webpubsub.azure.com`. Reached with the site's managed identity to negotiate browser access and send messages |
| `NOTIFICATION_CLI_VAPID_PUBLIC_KEY` | Push only. URL-safe VAPID public key returned to signed-in browsers |
| `NOTIFICATION_CLI_VAPID_PRIVATE_KEY` | Push only. Secret VAPID private key used only by the API |
| `NOTIFICATION_CLI_VAPID_SUBJECT` | Push only. VAPID contact URI, normally `mailto:you@example.com` |
| `NOTIFICATION_CLI_STORAGE_TABLE_ENDPOINT` | `https://<account>.table.core.windows.net/`. Reached with the site's managed identity for durable push subscriptions, per-user API keys, notification history and metrics |
| `NOTIFICATION_CLI_RETENTION_DAYS` | Optional. Whole number of days notifications stay readable in the frontend. Defaults to `7`, maximum `365` |
| `NOTIFICATION_CLI_ENTRA_TENANT_ID` | Directory of the Entra application used to sign users in |
| `NOTIFICATION_CLI_ENTRA_CLIENT_ID` | Application ID of that registration |
| `NOTIFICATION_CLI_ENTRA_CLIENT_SECRET` | Client secret of that registration. Optional: unset means a managed-identity assertion, or no credential at all for a public client |
| `NOTIFICATION_CLI_ENTRA_USE_MANAGED_IDENTITY` | `true` to prove the client with the site's managed identity, which needs a matching federated credential on a registration in the same tenant. Anything else signs in as a public client, and the template refuses `true` across tenants |
| `NOTIFICATION_CLI_SESSION_SECRET` | The HMAC key signing the sign-in cookie; generate 32 random bytes as shown in [Hosting](#hosting). Changing it signs every browser out |
| `NOTIFICATION_CLI_CLARITY_PROJECT_ID` | Optional. Microsoft Clarity project ID. Unset means no analytics tag is loaded and no third-party origin is allowed. See [Usage analytics](#usage-analytics) |
| `NOTIFICATION_CLI_WEB_ROOT` | Optional path to the frontend files. Defaults to `web` next to the bundle |

Every setting the template can neither derive nor read back off the site is
created as a placeholder whose value begins with `TODO:` and describes what
belongs there, so the Environment variables blade lists the whole job rather
than leaving unset settings invisible. Replace the value to configure one; the
server reads any value still carrying the marker as unset, so a placeholder is
never sent to Entra ID or used to sign a cookie. Placeholders lose to every
real value, including one set by hand, so re-running the template cannot
overwrite a setting you have filled in.

Real-time delivery through Web PubSub is the required core transport. The
"push only" settings are an optional enhancement: when any of them is missing,
notifications are still delivered live to open pages and the response reports
`"pushConfigured": false` instead of failing. Missing a **required** setting
makes `/api/notify` answer `503` naming the exact variable, for example
`{"error":"NOTIFICATION_CLI_STORAGE_TABLE_ENDPOINT is not configured."}`.

Generate a VAPID key pair once and keep it stable. Rotating it requires clients
to create a new browser subscription:

```powershell
pnpm --filter @notification-cli/core exec web-push generate-vapid-keys
```

The frontend calls `/api/negotiate` to receive a short-lived client URL and
then opens a secure WebSocket. It receives only the VAPID public key; the
VAPID private key, the per-user API keys, and the service endpoints the site
reaches with its managed identity remain server-side.

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

#### "Unknown application" at the consent page

Registrations are stored with the deployment, so rebuilding the storage
account — a fresh provision, or a move to another subscription — discards every
one of them, along with the signing key and every token already issued.

Clients cache their registration against the server's address, which does not
change, and [VS Code does not evict a registration the server has
rejected](https://github.com/microsoft/vscode/issues/321834). So the client
keeps presenting an identity this server has never heard of, and no amount of
retrying helps.

Clear the client's saved credentials. In VS Code that is **Authentication:
Remove Dynamic Authentication Providers**, from the Command Palette; the next
connection registers again. The consent page says as much, since it is the only
place the failure is visible.

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
`AZURE_APP_SERVICE_NAME` and the repository secrets `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`. The workflow in
`.github\workflows\deploy.yml` tests and builds the CLI installers, checks and
packages the web application, and deploys `dist\server` to App Service. Unlike
the infrastructure workflow it also runs on every push to `main`.

The deploy workflow validates every deployment setting before it calls Azure, so
a missing site name or identity fails the run with an explicit error instead of
silently skipping the deployment. Publishing signs in with OpenID Connect, so no
publish profile or other long-lived credential is stored.

## Breaking migration for this release

This release retires the Static Web App and makes the App Service the only
host. Upgrade an existing deployment in this order:

1. Provision the App Service with the updated infrastructure workflow and
   configure `AZURE_APP_SERVICE_NAME` plus the federated deployment identity
   for deployment.
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

- Never place a service endpoint or credential in a `VITE_*` variable. Vite
  variables are embedded in browser assets.
- Storage and Web PubSub are reached with the site's managed identity, and
  both have key-based access switched off, so there is no account key or
  connection string anywhere to leak. Keep the VAPID private key, the Entra
  client secret and the session secret server-side.
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
