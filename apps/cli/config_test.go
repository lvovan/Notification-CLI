package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const testAPIKey = "ncli_testsecretkey"

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

	actual, err := loadConfiguration(path)
	if err != nil {
		t.Fatalf("load configuration: %v", err)
	}
	if actual != expected {
		t.Fatalf("got %#v, want %#v", actual, expected)
	}
}

// The environment variables are gone, so a leftover value must not be able to
// redirect a notification to another service.
func TestEnvironmentIsIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	saved := configuration{APIURL: "https://example.com", APIKey: testAPIKey}
	if err := saveConfiguration(saved, path); err != nil {
		t.Fatalf("save configuration: %v", err)
	}
	for _, name := range []string{"NOTIFICATION_CLI_API_URL", "NOTIFICATION_CLI_API_KEY"} {
		t.Setenv(name, "https://attacker.example")
	}

	actual, err := loadConfiguration(path)
	if err != nil {
		t.Fatalf("load configuration: %v", err)
	}
	if actual != saved {
		t.Fatalf("environment leaked into configuration: %#v", actual)
	}
}

func TestMissingConfigurationExplainsHowToConfigure(t *testing.T) {
	t.Setenv("NOTIFICATION_CLI_API_URL", "https://alternate.example")
	t.Setenv("NOTIFICATION_CLI_API_KEY", testAPIKey)

	_, err := loadConfiguration(filepath.Join(t.TempDir(), "missing.json"))
	if err == nil || !strings.Contains(err.Error(), "--configure") {
		t.Fatalf("expected actionable configuration error, got %v", err)
	}
	if strings.Contains(err.Error(), "NOTIFICATION_CLI_API") {
		t.Fatalf("error still advertises the obsolete environment variables: %v", err)
	}
}

func TestValidateAPIKeyRequiresPrefix(t *testing.T) {
	t.Parallel()

	if err := validateAPIKey(testAPIKey); err != nil {
		t.Fatalf("expected prefixed key to be accepted: %v", err)
	}
	for name, value := range map[string]string{
		"empty":       "",
		"unprefixed":  "secret",
		"wrong case":  "NCLI_secret",
		"prefix late": "xncli_secret",
	} {
		if err := validateAPIKey(value); err == nil {
			t.Fatalf("expected %s key to be rejected", name)
		}
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

func TestVerifyAPIKeySucceeds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/whoami" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if actual := request.Header.Get("x-api-key"); actual != testAPIKey {
			t.Errorf("unexpected x-api-key header: %s", actual)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{"email": "user@example.com"})
	}))
	defer server.Close()

	config := configuration{APIURL: server.URL, APIKey: testAPIKey}
	email, err := verifyAPIKey(t.Context(), server.Client(), config)
	if err != nil {
		t.Fatalf("verify API key: %v", err)
	}
	if email != "user@example.com" {
		t.Fatalf("got email %q", email)
	}
}

func TestVerifyAPIKeyRejectsUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":"Unauthorized: ` + testAPIKey + `"}`))
	}))
	defer server.Close()

	config := configuration{APIURL: server.URL, APIKey: testAPIKey}
	_, err := verifyAPIKey(t.Context(), server.Client(), config)
	if err == nil || !strings.Contains(err.Error(), "API key section") {
		t.Fatalf("expected actionable rejection error, got %v", err)
	}
	if !strings.Contains(err.Error(), "mistyped or truncated") {
		t.Fatalf("expected error to mention mistyped or truncated keys, got %v", err)
	}
	if strings.Contains(err.Error(), testAPIKey) {
		t.Fatal("error exposed API key")
	}
}

func TestVerifyAPIKeyRejectsGarbageResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("not json at all"))
	}))
	defer server.Close()

	config := configuration{APIURL: server.URL, APIKey: testAPIKey}
	_, err := verifyAPIKey(t.Context(), server.Client(), config)
	if err == nil || !strings.Contains(err.Error(), "unexpected response") {
		t.Fatalf("expected unexpected-response error, got %v", err)
	}
}

// The account is optional, so a service that omits it still verifies the key.
func TestVerifyAPIKeyAcceptsMissingEmail(t *testing.T) {
	for name, body := range map[string]string{
		"omitted": `{"authorized":true}`,
		"blank":   `{"email":"   "}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write([]byte(body))
			}))
			defer server.Close()

			config := configuration{APIURL: server.URL, APIKey: testAPIKey}
			email, err := verifyAPIKey(t.Context(), server.Client(), config)
			if err != nil {
				t.Fatalf("verify API key: %v", err)
			}
			if email != "" {
				t.Fatalf("got email %q, want empty", email)
			}
		})
	}
}
func TestVerifyAPIKeyHandlesTransportFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	client := server.Client()
	url := server.URL
	server.Close()

	config := configuration{APIURL: url, APIKey: testAPIKey}
	_, err := verifyAPIKey(t.Context(), client, config)
	if err == nil || !strings.Contains(err.Error(), "verify API key") {
		t.Fatalf("expected transport failure error, got %v", err)
	}
	if strings.Contains(err.Error(), testAPIKey) {
		t.Fatal("error exposed API key")
	}
}
