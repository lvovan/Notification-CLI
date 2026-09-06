/*
  Notification CLI infrastructure.

  Creates every Azure resource the solution needs:

    - Azure Web PubSub (Free_F1): real-time transport to open browser tabs.
    - Azure Storage (Standard_LRS): five tables holding per-user push
      subscriptions, notification metrics, retained notification history, the
      API keys minted for each authorized account, and OAuth state.
    - Azure App Service (B1): hosts the PWA, API and OAuth authorization
      server.

  The template also writes the App Service environment variables, wiring in the
  connection strings of the resources above so no secret has to be copied by
  hand.

  Application code is NOT deployed here. Run the deploy workflow afterwards; it
  uploads the built server package to App Service.

  Settings the template is not given are read back off the running site and
  kept, so re-running it can never blank a value that was set out of band. See
  `siteExists` for how that is decided, and why it fails loudly rather than
  quietly erasing configuration.

  Values it can neither derive nor read back are written as "TODO:"
  placeholders, so every setting an operator still has to supply is listed in
  the App Service configuration blade alongside a note saying what belongs
  there. The server treats a placeholder as unset.
*/

@description('Prefix for generated resource names. Lower-case letters and digits work best, because the storage account name is derived from it. Changing this on an existing deployment builds a second, empty copy of every resource rather than renaming anything.')
@minLength(3)
@maxLength(24)
param namePrefix string = 'notification-lvovan'

@description('Azure region for every resource. Defaults to the resource group location; existing deployments must keep using the region their resources were created in.')
param location string = resourceGroup().location

/*
  Whether the App Service site is already deployed.

  When true the template reads the site's current application settings and
  keeps every value it was not explicitly given. That is what lets the Entra
  registration, session key, VAPID pair and analytics ID survive a re-run
  without being stored as CI secrets.

  It defaults to true because the two ways of getting it wrong are not equally
  bad: passing true for a site that does not exist fails the deployment with a
  plain "not found", while passing false for a site that does exist would
  silently erase its configuration. The safe answer is the default, and a first
  deployment has to say so deliberately.
*/
@description('Set to false only for the very first deployment, before the App Service site exists.')
param siteExists bool = true

@description('URL-safe VAPID public key handed to authorized browsers. Leave empty to keep the deployed value; Web Push stays off until a pair is set.')
param vapidPublicKey string = ''

@description('Secret VAPID private key, used only by the API. Leave empty to keep the deployed value.')
@secure()
param vapidPrivateKey string = ''

@description('VAPID contact URI, normally "mailto:you@example.com". Leave empty to keep the deployed value.')
param vapidSubject string = ''

@description('Days a notification stays readable in the frontend. Metrics live in a separate table and are unaffected by this window.')
@minValue(1)
@maxValue(365)
param retentionDays int = 7

@description('Directory (tenant) ID of the Entra application the App Service host signs users in with. Leave empty to keep the deployed value.')
param entraTenantId string = ''

@description('Application (client) ID of that Entra application. Leave empty to keep the deployed value.')
param entraClientId string = ''

@description('Client secret of that Entra application. Optional: tenants that forbid secrets by policy sign in with the site managed identity instead.')
@secure()
param entraClientSecret string = ''

@description('Key used to sign the App Service session cookie. Changing it signs every browser out. Leave empty to keep the deployed value.')
@secure()
param sessionSecret string = ''

@description('Microsoft Clarity project ID. Leave empty to keep the deployed value; unset entirely means no analytics tag is loaded.')
param clarityProjectId string = ''

/*
  Storage account names are globally unique, lower-case, alphanumeric and at
  most 24 characters, so they cannot simply reuse the prefix. The derived name
  is deterministic rather than hashed, because a hash would not resolve to the
  account an existing deployment already stores its tables in. Override the
  parameter if the derived name is taken in another subscription.
*/
@description('Storage account name. Defaults to the prefix with punctuation removed and "sto" appended.')
@maxLength(24)
param storageAccountName string = take('${toLower(replace(namePrefix, '-', ''))}sto', 24)

var webPubSubName = '${namePrefix}-wps'
var appServicePlanName = '${namePrefix}-asp'
var appServiceName = '${namePrefix}-wa'

// Table names are fixed by the API. Creating them here makes a fresh
// deployment immediately consistent, even though the API also creates them on
// demand.
var tableNames = [
  'PushSubscriptions'
  'NotificationMetrics'
  'NotificationHistory'
  'ApiKeys'
  'NotificationOAuth'
]

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-08-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    // The API reaches Table Storage with the account key embedded in its
    // connection string, so shared key access stays enabled.
    allowSharedKeyAccess: true
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2025-08-01' = {
  parent: storageAccount
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2025-08-01' = [
  for tableName in tableNames: {
    parent: tableService
    name: tableName
  }
]

resource webPubSub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: webPubSubName
  location: location
  sku: {
    name: 'Free_F1'
    tier: 'Free'
    capacity: 1
  }
  properties: {
    // Browsers never see this resource directly: /api/negotiate mints a
    // short-lived client access URL for the "notifications" hub instead.
    disableLocalAuth: false
    publicNetworkAccess: 'Enabled'
    /*
      networkACLs is deliberately not set. The Free tier rejects it outright
      ("Free tier doesn't support setting network ACLs"), and it does not need
      it: the service applies allow-all defaults on creation and leaves them
      untouched on later deployments. Verified by deploying this resource twice
      without the property and reading the rules back both times.
    */
  }
}

// Reads the settings already on the running site. Guarded by siteExists so a
// first deployment, which has nothing to read, short-circuits instead of
// failing on a missing resource.
resource deployedSite 'Microsoft.Web/sites@2024-11-01' existing = if (siteExists) {
  name: appServiceName
}

var deployedSettings = siteExists
  ? list('${deployedSite.id}/config/appsettings', '2024-11-01').properties
  : {}

// Owned by the template: derived from the resources above, so these always win
// over whatever the site currently holds.
var derivedSettings = {
  NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING: webPubSub.listKeys().primaryConnectionString
  NOTIFICATION_CLI_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
  NOTIFICATION_CLI_RETENTION_DAYS: string(retentionDays)
  // The package ships already bundled, so Oryx has nothing to build. The entry
  // point comes from the generated package.json, which is why no startup
  // command is configured below.
  SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
}

/*
  Written only when nothing else supplies the setting, so every value an
  operator has to fill in appears in the App Service configuration blade with a
  note saying what belongs there. A missing setting is otherwise invisible.

  The "TODO:" marker is what the server recognises to treat these as unset, so
  a placeholder is never sent to Entra ID or used to sign a session cookie. It
  must stay in step with PLACEHOLDER_PREFIX in packages/core.

  NOTIFICATION_CLI_ENTRA_CLIENT_SECRET is deliberately absent: a tenant that
  forbids secrets by policy signs in with the site managed identity instead, so
  prompting for one would be advice to do the wrong thing.
*/
var placeholderPrefix = 'TODO:'

var placeholderSettings = {
  NOTIFICATION_CLI_ENTRA_TENANT_ID: '${placeholderPrefix} directory (tenant) ID of the Entra application, a GUID from its Overview blade'
  NOTIFICATION_CLI_ENTRA_CLIENT_ID: '${placeholderPrefix} application (client) ID of the Entra application, a GUID from its Overview blade'
  NOTIFICATION_CLI_SESSION_SECRET: '${placeholderPrefix} random secret signing the session cookie, at least 32 characters; changing it signs every browser out'
  NOTIFICATION_CLI_VAPID_PUBLIC_KEY: '${placeholderPrefix} VAPID public key, 87 URL-safe characters starting with B; generate a pair with "npx web-push generate-vapid-keys"'
  NOTIFICATION_CLI_VAPID_PRIVATE_KEY: '${placeholderPrefix} VAPID private key from the same generated pair; never share it'
  NOTIFICATION_CLI_VAPID_SUBJECT: '${placeholderPrefix} VAPID contact URI, normally "mailto:you@example.com"'
  NOTIFICATION_CLI_CLARITY_PROJECT_ID: '${placeholderPrefix} Microsoft Clarity project ID, or delete this setting to load no analytics tag'
}

/*
  Supplied by the caller. An empty parameter contributes nothing at all rather
  than an empty string, which is what makes "leave it blank to keep what is
  deployed" work: the merge below simply finds no newer value to apply.
*/
var suppliedSettings = union(
  empty(entraTenantId) ? {} : { NOTIFICATION_CLI_ENTRA_TENANT_ID: entraTenantId },
  empty(entraClientId) ? {} : { NOTIFICATION_CLI_ENTRA_CLIENT_ID: entraClientId },
  empty(entraClientSecret) ? {} : { NOTIFICATION_CLI_ENTRA_CLIENT_SECRET: entraClientSecret },
  empty(sessionSecret) ? {} : { NOTIFICATION_CLI_SESSION_SECRET: sessionSecret },
  empty(vapidPublicKey) ? {} : { NOTIFICATION_CLI_VAPID_PUBLIC_KEY: vapidPublicKey },
  empty(vapidPrivateKey) ? {} : { NOTIFICATION_CLI_VAPID_PRIVATE_KEY: vapidPrivateKey },
  empty(vapidSubject) ? {} : { NOTIFICATION_CLI_VAPID_SUBJECT: vapidSubject },
  empty(clarityProjectId) ? {} : { NOTIFICATION_CLI_CLARITY_PROJECT_ID: clarityProjectId }
)

/*
  Later arguments win, so a supplied value overrides the deployed one and the
  derived connection strings override everything. Placeholders come first and
  therefore lose to any real value, including one set by hand on the site.
*/
var effectiveSettings = union(placeholderSettings, deployedSettings, derivedSettings, suppliedSettings)

/*
  The App Service host.

  It exists because the Model Context Protocol requires the real bearer
  authorization header, while Static Web Apps replaced that header with its
  own platform token before a managed function was invoked. OAuth could
  therefore never work behind the Static Web App, whatever the API did.

  B1 is the smallest tier that supports Always On and a free managed
  certificate, both of which this host needs. Custom domains and certificates
  stay manually managed because the managed-certificate flow is not reliably
  single-pass declarative; the hostname bindings already on the site are child
  resources and are left untouched by this template.
*/
resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource appService 'Microsoft.Web/sites@2024-11-01' = {
  name: appServiceName
  location: location
  kind: 'app,linux'
  // The identity is what lets the site authenticate to Entra ID without a
  // client secret, which some tenants forbid by policy.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
    }
  }
}

/*
  Application settings are written by a module rather than declared here.

  The set to apply is built by merging in the settings the site already has,
  and ARM rejects a template in which a resource is derived from a `list()` of
  its own resource ID as a circular dependency. Reading and writing the same
  resource therefore has to be split across two templates.

  They are also not part of siteConfig above, because an appSettings array
  there must be computable before the deployment starts, which a lookup of the
  running site cannot be.
*/
module appServiceSettings 'app-settings.bicep' = {
  name: 'appsettings'
  params: {
    // Referring to the site resource is what orders this after it exists.
    siteName: appService.name
    settings: effectiveSettings
  }
}

@description('Name of the Web PubSub instance backing real-time delivery.')
output webPubSubName string = webPubSub.name

@description('Name of the storage account holding subscriptions, metrics and notification history.')
output storageAccountName string = storageAccount.name

@description('Whether Web Push is configured. When false, notifications only reach open browser tabs.')
output pushConfigured bool = !startsWith(effectiveSettings.NOTIFICATION_CLI_VAPID_PUBLIC_KEY, placeholderPrefix)

@description('Whether browser analytics are configured. When false, no third-party tag is loaded.')
output telemetryConfigured bool = !startsWith(effectiveSettings.NOTIFICATION_CLI_CLARITY_PROJECT_ID, placeholderPrefix)

@description('Name of the App Service host. Store this as the AZURE_APP_SERVICE_NAME repository variable.')
output appServiceName string = appService.name

@description('Hostname of the App Service host. This is the origin MCP clients discover the authorization server on.')
output appServiceHostname string = appService.properties.defaultHostName

@description('Subject of the federated credential to add when no client secret is used.')
output appServicePrincipalId string = appService.identity.principalId
