package main

// These variables exist for MCP clients, which have no configuration file of
// their own. --configure writes them; nothing in this CLI ever reads them.
const (
	apiURLEnvironmentVariable = "NOTIFICATION_CLI_API_URL"
	apiKeyEnvironmentVariable = "NOTIFICATION_CLI_API_KEY"
)

// exportedEnvironment lists what --configure publishes, in a stable order so
// the console output and the profile block stay predictable.
func exportedEnvironment(config configuration) [][2]string {
	return [][2]string{
		{apiURLEnvironmentVariable, config.APIURL},
		{apiKeyEnvironmentVariable, config.APIKey},
	}
}
