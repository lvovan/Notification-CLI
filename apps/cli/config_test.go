package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const testAPIKey = "test-secret-key"

func TestValidateAPIURL(t *testing.T) {
	t.Parallel()

	if actual, err := validateAPIURL("https://example.com/"); err != nil || actual != "https://example.com" {
		t.Fatalf("validate secure URL: got %q, %v", actual, err)
	}
	if _, err := validateAPIURL("http://example.com"); err == nil {
		t.Fatal("expected insecure remote URL to be rejected")
	}
	if _, err := validateAPIURL("http://localhost:8080"); err != nil {
		t.Fatalf("expected localhost HTTP URL to be accepted: %v", err)
	}
	if _, err := validateAPIURL("https://key@example.com"); err == nil {
		t.Fatal("expected embedded credentials to be rejected")
	}
}

func TestSaveAndLoadConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	expected := configuration{APIURL: "https://example.com", APIKey: testAPIKey}
	if err := saveConfiguration(expected, path); err != nil {
		t.Fatalf("save configuration: %v", err)
	}
	t.Setenv(apiURLEnvironmentVariable, "")
	t.Setenv(apiKeyEnvironmentVariable, "")

	actual, err := loadConfiguration(path)
	if err != nil {
		t.Fatalf("load configuration: %v", err)
	}
	if actual != expected {
		t.Fatalf("got %#v, want %#v", actual, expected)
	}
}

func TestEnvironmentTakesPrecedence(t *testing.T) {
	t.Setenv(apiURLEnvironmentVariable, "https://alternate.example")
	t.Setenv(apiKeyEnvironmentVariable, testAPIKey)

	actual, err := loadConfiguration(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatalf("load environment configuration: %v", err)
	}
	if actual.APIURL != "https://alternate.example" || actual.APIKey != testAPIKey {
		t.Fatalf("unexpected configuration: %#v", actual)
	}
}

func TestMissingConfigurationExplainsHowToConfigure(t *testing.T) {
	t.Setenv(apiURLEnvironmentVariable, "")
	t.Setenv(apiKeyEnvironmentVariable, "")
	_, err := loadConfiguration(filepath.Join(t.TempDir(), "missing.json"))
	if err == nil ||
		!strings.Contains(err.Error(), apiURLEnvironmentVariable) ||
		!strings.Contains(err.Error(), apiKeyEnvironmentVariable) {
		t.Fatalf("expected actionable configuration error, got %v", err)
	}
}

func TestPostNotification(t *testing.T) {
	var received struct {
		Message string `json:"message"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/notify" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if actual := request.Header.Get("x-api-key"); actual != testAPIKey {
			t.Errorf("unexpected x-api-key header")
		}
		if actual := request.Header.Get("Content-Type"); actual != "application/json" {
			t.Errorf("unexpected content type: %s", actual)
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		writer.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	config := configuration{APIURL: server.URL, APIKey: testAPIKey}
	if err := postNotification(t.Context(), server.Client(), config, "build complete"); err != nil {
		t.Fatalf("post notification: %v", err)
	}
	if received.Message != "build complete" {
		t.Fatalf("got message %q", received.Message)
	}
}

func TestPostNotificationHandlesServiceError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "invalid API key: "+testAPIKey, http.StatusUnauthorized)
	}))
	defer server.Close()

	config := configuration{APIURL: server.URL, APIKey: testAPIKey}
	err := postNotification(t.Context(), server.Client(), config, "hello")
	if err == nil || !strings.Contains(err.Error(), "401 Unauthorized") {
		t.Fatalf("expected status error, got %v", err)
	}
	if strings.Contains(err.Error(), testAPIKey) {
		t.Fatal("error exposed API key")
	}
}

func TestPostNotificationRejectsOversizedMessage(t *testing.T) {
	config := configuration{APIURL: "https://example.com", APIKey: testAPIKey}
	err := postNotification(t.Context(), http.DefaultClient, config, strings.Repeat("x", maxMessageCharacters+1))
	if err == nil || !strings.Contains(err.Error(), "character limit") {
		t.Fatalf("expected size error, got %v", err)
	}
}
