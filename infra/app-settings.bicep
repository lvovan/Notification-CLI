/*
  Writes the App Service application settings.

  This is a separate module for one reason: the settings that get written are
  built by merging in the settings the site already has, and ARM refuses a
  template where a resource is derived from a `list()` of its own resource ID.
  Reading and writing the same resource has to happen in two templates, so the
  parent reads and this module writes.
*/

@description('Name of the App Service site to configure. The site must already be deployed.')
param siteName string

// Marked secure so the merged settings, which include the storage and Web
// PubSub connection strings, the session signing key and the VAPID private
// key, are redacted in the deployment history rather than recorded in it.
@description('Complete set of application settings to apply.')
@secure()
param settings object

resource site 'Microsoft.Web/sites@2024-11-01' existing = {
  name: siteName
}

resource appSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: site
  name: 'appsettings'
  properties: settings
}
