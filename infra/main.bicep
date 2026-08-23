/*
  Notification CLI infrastructure.

  Creates every Azure resource the solution needs, all on Free tiers:

    - Azure Web PubSub (Free_F1): real-time transport to open browser tabs.
    - Azure Storage (Standard_LRS): three tables holding push subscriptions,
      notification metrics and the retained notification history.
    - Azure Static Web App (Free): hosts the PWA and the Functions API, and
      provides the built-in Microsoft Entra ID sign-in that gates the frontend.

  The template also writes the Static Web App's environment variables, wiring
  in the connection strings of the resources above so no secret has to be
  copied by hand.

  Application code is NOT deployed here. Run the deploy workflow afterwards; it
  uploads the built frontend and API using the Static Web App deployment token.
*/

@description('Prefix for generated resource names. Lower-case letters and digits work best, because the storage account name is derived from it.')
@minLength(3)
@maxLength(24)
param namePrefix string = 'notification-cli'

@description('Region for every resource. Restricted to the regions where the Static Web Apps Free tier is available.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param location string = 'westeurope'

@description('Semicolon-separated Microsoft account email addresses allowed to open the web frontend, for example "first@example.com;second@example.com".')
param authorizedUsers string

@description('Long random key the Go CLI presents to /api/notify.')
@secure()
@minLength(32)
param notificationApiKey string

@description('Separate long random key the MCP server presents to /api/mcp. Must differ from the CLI key so either can be rotated on its own.')
@secure()
@minLength(32)
param mcpApiKey string

@description('URL-safe VAPID public key handed to authorized browsers. Leave empty to deploy without Web Push; live delivery to open tabs still works.')
param vapidPublicKey string = ''

@description('Secret VAPID private key, used only by the API. Required when vapidPublicKey is set.')
@secure()
param vapidPrivateKey string = ''

@description('VAPID contact URI, normally "mailto:you@example.com". Required when vapidPublicKey is set.')
param vapidSubject string = ''

@description('Days a notification stays readable in the frontend. Metrics live in a separate table and are unaffected by this window.')
@minValue(1)
@maxValue(365)
param retentionDays int = 7

@description('Optional custom domain, for example "notify.example.com". The DNS record must already point at the Static Web App, otherwise validation blocks the deployment. Leave empty to use the generated azurestaticapps.net hostname.')
param customDomain string = ''

// Storage account names are globally unique, lower-case, alphanumeric and at
// most 24 characters, so they cannot simply reuse the prefix.
var storageAccountName = take(
  '${toLower(replace(namePrefix, '-', ''))}${uniqueString(resourceGroup().id)}',
  24
)
var webPubSubName = '${namePrefix}-wps'
var staticWebAppName = '${namePrefix}-swa'

// Table names are fixed by the API. Creating them here makes a fresh
// deployment immediately consistent, even though the API also creates them on
// demand.
var tableNames = [
  'PushSubscriptions'
  'NotificationMetrics'
  'NotificationHistory'
]

var pushConfigured = !empty(vapidPublicKey)

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
  }
}

resource staticWebApp 'Microsoft.Web/staticSites@2024-11-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    // "Custom" stops Azure from generating its own GitHub workflow: this
    // repository deploys with the Azure/static-web-apps-deploy action instead.
    provider: 'Custom'
    // Required so the staticwebapp.config.json shipped with the frontend
    // controls routing, authentication and the cache headers the PWA needs.
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Disabled'
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

// Replaces the complete application settings collection on every deployment,
// so any setting added by hand in the portal is removed. Add new settings
// here instead.
resource staticWebAppSettings 'Microsoft.Web/staticSites/config@2024-11-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: union(
    {
      NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING: webPubSub.listKeys().primaryConnectionString
      NOTIFICATION_CLI_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
      NOTIFICATION_CLI_API_KEY: notificationApiKey
      NOTIFICATION_CLI_MCP_API_KEY: mcpApiKey
      NOTIFICATION_CLI_RETENTION_DAYS: string(retentionDays)
      AUTHORIZED_USERS: authorizedUsers
    },
    pushConfigured
      ? {
          NOTIFICATION_CLI_VAPID_PUBLIC_KEY: vapidPublicKey
          NOTIFICATION_CLI_VAPID_PRIVATE_KEY: vapidPrivateKey
          NOTIFICATION_CLI_VAPID_SUBJECT: vapidSubject
        }
      : {}
  )
}

// Validation polls DNS, so an unresolvable record leaves the deployment
// running until it times out. Create the CNAME first.
resource domain 'Microsoft.Web/staticSites/customDomains@2024-11-01' = if (!empty(customDomain)) {
  parent: staticWebApp
  name: customDomain
}

@description('Name of the Static Web App, needed to read its deployment token.')
output staticWebAppName string = staticWebApp.name

@description('Generated hostname of the Static Web App. A configured custom domain serves the same content.')
output staticWebAppHostname string = staticWebApp.properties.defaultHostname

@description('Name of the Web PubSub instance backing real-time delivery.')
output webPubSubName string = webPubSub.name

@description('Name of the storage account holding subscriptions, metrics and notification history.')
output storageAccountName string = storageAccount.name

@description('Whether Web Push settings were supplied. When false, notifications only reach open browser tabs.')
output pushConfigured bool = pushConfigured
