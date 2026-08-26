/*
  Notification CLI infrastructure.

  Creates every Azure resource the solution needs:

    - Azure Web PubSub (Free_F1): real-time transport to open browser tabs.
    - Azure Storage (Standard_LRS): four tables holding per-user push
      subscriptions, notification metrics, retained notification history and
      the API keys minted for each authorized account.
    - Azure App Service (B1): hosts the PWA, API and OAuth authorization
      server.

  The template also writes the App Service environment variables, wiring in the
  connection strings of the resources above so no secret has to be copied by
  hand.

  Application code is NOT deployed here. Run the deploy workflow afterwards; it
  uploads the built server package to App Service.
*/

@description('Prefix for generated resource names. Lower-case letters and digits work best, because the storage account name is derived from it.')
@minLength(3)
@maxLength(24)
param namePrefix string = 'notification-cli'

@description('Azure region for every resource. Defaults to the resource group location; existing deployments must keep using the region their resources were created in.')
param location string = resourceGroup().location

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

@description('Directory (tenant) ID of the Entra application the App Service host signs users in with.')
param entraTenantId string = ''

@description('Application (client) ID of that Entra application.')
param entraClientId string = ''

@description('Client secret of that Entra application.')
@secure()
param entraClientSecret string = ''

@description('Key used to sign the App Service session cookie. Changing it signs every browser out.')
@secure()
param sessionSecret string = ''

// Storage account names are globally unique, lower-case, alphanumeric and at
// most 24 characters, so they cannot simply reuse the prefix.
var storageAccountName = take(
  '${toLower(replace(namePrefix, '-', ''))}${uniqueString(resourceGroup().id)}',
  24
)
var webPubSubName = '${namePrefix}-wps'
var appServicePlanName = '${namePrefix}-plan'
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

// Every setting the App Service host needs. It adds the sign-in and session
// settings below, because it authenticates users itself.
var sharedSettings = concat(
  [
    {
      name: 'NOTIFICATION_CLI_AZURE_WEB_PUBSUB_CONNECTION_STRING'
      value: webPubSub.listKeys().primaryConnectionString
    }
    {
      name: 'NOTIFICATION_CLI_STORAGE_CONNECTION_STRING'
      value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    }
    {
      name: 'NOTIFICATION_CLI_RETENTION_DAYS'
      value: string(retentionDays)
    }
  ],
  pushConfigured
    ? [
        {
          name: 'NOTIFICATION_CLI_VAPID_PUBLIC_KEY'
          value: vapidPublicKey
        }
        {
          name: 'NOTIFICATION_CLI_VAPID_PRIVATE_KEY'
          value: vapidPrivateKey
        }
        {
          name: 'NOTIFICATION_CLI_VAPID_SUBJECT'
          value: vapidSubject
        }
      ]
    : []
)

/*
  The App Service host.

  It exists because the Model Context Protocol requires the real bearer
  authorization header, while Static Web Apps replaced that header with its
  own platform token before a managed function was invoked. OAuth could
  therefore never work behind the Static Web App, whatever the API did.

  B1 is the smallest tier that supports Always On and a free managed
  certificate, both of which this host needs. Custom domains and certificates
  stay manually managed because the managed-certificate flow is not reliably
  single-pass declarative.
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
      linuxFxVersion: 'NODE|22-lts'
      // The deployed package is an already-bundled single file.
      appCommandLine: 'node dist/main.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      appSettings: concat(sharedSettings, [
        {
          name: 'NOTIFICATION_CLI_ENTRA_TENANT_ID'
          value: entraTenantId
        }
        {
          name: 'NOTIFICATION_CLI_ENTRA_CLIENT_ID'
          value: entraClientId
        }
        {
          name: 'NOTIFICATION_CLI_ENTRA_CLIENT_SECRET'
          value: entraClientSecret
        }
        {
          name: 'NOTIFICATION_CLI_SESSION_SECRET'
          value: sessionSecret
        }
        {
          // The package ships already bundled, so Oryx has nothing to build.
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
      ])
    }
  }
}

@description('Name of the Web PubSub instance backing real-time delivery.')
output webPubSubName string = webPubSub.name

@description('Name of the storage account holding subscriptions, metrics and notification history.')
output storageAccountName string = storageAccount.name

@description('Whether Web Push settings were supplied. When false, notifications only reach open browser tabs.')
output pushConfigured bool = pushConfigured

@description('Name of the App Service host.')
output appServiceName string = appService.name

@description('Hostname of the App Service host. This is the origin MCP clients discover the authorization server on.')
output appServiceHostname string = appService.properties.defaultHostName

@description('Subject of the federated credential to add when no client secret is used.')
output appServicePrincipalId string = appService.identity.principalId
