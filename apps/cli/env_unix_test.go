//go:build !windows

package main

import (
	"strings"
	"testing"
)

func TestProfileBlockIsReplacedRatherThanRepeated(t *testing.T) {
	first := replaceProfileBlock("export EDITOR=vi\n", profileBlock(configuration{
		APIURL: "https://first.test",
		APIKey: testAPIKey,
	}))
	second := replaceProfileBlock(first, profileBlock(configuration{
		APIURL: "https://second.test",
		APIKey: testAPIKey,
	}))

	if count := strings.Count(second, profileBlockStart); count != 1 {
		t.Fatalf("profile holds %d managed blocks, want 1", count)
	}
	if !strings.Contains(second, "https://second.test") {
		t.Error("profile does not carry the new URL")
	}
	if strings.Contains(second, "https://first.test") {
		t.Error("profile still carries the replaced URL")
	}
	if !strings.HasPrefix(second, "export EDITOR=vi\n") {
		t.Error("profile lost the lines around the managed block")
	}
}

func TestProfileBlockQuotesValues(t *testing.T) {
	block := profileBlock(configuration{APIURL: "https://example.test/a b", APIKey: "ncli_it's"})

	if !strings.Contains(block, `export NOTIFICATION_CLI_API_URL='https://example.test/a b'`) {
		t.Errorf("URL is not quoted: %s", block)
	}
	if !strings.Contains(block, `export NOTIFICATION_CLI_API_KEY='ncli_it'\''s'`) {
		t.Errorf("quote in the key is not escaped: %s", block)
	}
}
