package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportedEnvironmentCarriesBothSettings(t *testing.T) {
	exported := exportedEnvironment(configuration{APIURL: "https://example.test", APIKey: testAPIKey})

	want := map[string]string{
		apiURLEnvironmentVariable: "https://example.test",
		apiKeyEnvironmentVariable: testAPIKey,
	}
	if len(exported) != len(want) {
		t.Fatalf("exported %d variables, want %d", len(exported), len(want))
	}
	for _, variable := range exported {
		if want[variable[0]] != variable[1] {
			t.Errorf("%s = %q, want %q", variable[0], variable[1], want[variable[0]])
		}
	}
}

// The environment is written for MCP clients only. Reading it back would
// silently reintroduce the configuration source this CLI deliberately dropped,
// so the guard is on the source rather than on behaviour.
func TestNothingReadsTheExportedEnvironment(t *testing.T) {
	sources, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("list sources: %v", err)
	}

	forbidden := []string{
		"os.Getenv(" + apiURLEnvironmentVariable,
		"os.Getenv(" + apiKeyEnvironmentVariable,
		`os.Getenv("NOTIFICATION_CLI`,
		"os.Getenv(apiURLEnvironmentVariable",
		"os.Getenv(apiKeyEnvironmentVariable",
	}

	for _, source := range sources {
		if strings.HasSuffix(source, "_test.go") {
			continue
		}
		content, err := os.ReadFile(source)
		if err != nil {
			t.Fatalf("read %s: %v", source, err)
		}
		for _, pattern := range forbidden {
			if strings.Contains(string(content), pattern) {
				t.Errorf("%s contains %q; settings must come from the saved configuration", source, pattern)
			}
		}
	}
}
