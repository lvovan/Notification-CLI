package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxMessageCharacters = 1000
	maxErrorBodyBytes    = 4 * 1024
	notificationTimeout  = 15 * time.Second
)

var version = "development"

func banner() string {
	return fmt.Sprintf("Notification CLI v%s - (C) Luc Vo Van, 2026 - Built with AI", version)
}

func usage() {
	fmt.Println(banner())
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  notify <message>")
	fmt.Println("  notify --configure")
	fmt.Println("  notify --version")
}

func configure() error {
	apiURL := strings.TrimSpace(os.Getenv(apiURLEnvironmentVariable))
	apiKey := os.Getenv(apiKeyEnvironmentVariable)
	if apiURL == "" || apiKey == "" {
		return configurationInstructions()
	}
	config, err := validateConfiguration(configuration{APIURL: apiURL, APIKey: apiKey})
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	client := &http.Client{Timeout: notificationTimeout}
	email, err := verifyAPIKey(context.Background(), client, config)
	if err != nil {
		return err
	}
	path, err := configurationPath()
	if err != nil {
		return err
	}
	if err := saveConfiguration(config, path); err != nil {
		return err
	}
	fmt.Printf("Configuration saved to %s\n", path)
	fmt.Printf("The API key belongs to %s.\n", email)
	return nil
}

// verifyAPIKey resolves the configured key to its owner through /api/whoami so
// a wrong or revoked key is caught before the configuration is written.
func verifyAPIKey(ctx context.Context, client *http.Client, config configuration) (string, error) {
	endpoint := strings.TrimRight(config.APIURL, "/") + "/api/whoami"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("create verification request: %w", err)
	}
	request.Header.Set("x-api-key", config.APIKey)
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", errors.New("verify API key: request timed out")
		}
		return "", fmt.Errorf("verify API key: %w", err)
	}
	defer response.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes+1))
	if readErr != nil {
		return "", fmt.Errorf("read verification response: %w", readErr)
	}

	if response.StatusCode == http.StatusUnauthorized {
		return "", errors.New(
			"the API key was rejected; copy the current key from the API key section of the web app, " +
				"and make sure your account is in the authorized users list",
		)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		detail := safeResponseDetail(body, config.APIKey)
		if detail == "" {
			return "", fmt.Errorf("verification service returned %s", response.Status)
		}
		return "", fmt.Errorf("verification service returned %s: %s", response.Status, detail)
	}

	var payload struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || strings.TrimSpace(payload.Email) == "" {
		return "", errors.New("the verification service returned an unexpected response")
	}
	return payload.Email, nil
}

func sendNotification(message string) error {
	path, err := configurationPath()
	if err != nil {
		return err
	}
	config, err := loadConfiguration(path)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: notificationTimeout}
	if err := postNotification(context.Background(), client, config, message); err != nil {
		return err
	}
	fmt.Println("Notification sent.")
	return nil
}

func postNotification(ctx context.Context, client *http.Client, config configuration, message string) error {
	if utf8.RuneCountInString(message) > maxMessageCharacters {
		return fmt.Errorf("the notification message exceeds the %d-character limit", maxMessageCharacters)
	}
	payload, err := json.Marshal(struct {
		Message string `json:"message"`
	}{Message: message})
	if err != nil {
		return fmt.Errorf("encode notification: %w", err)
	}

	endpoint := strings.TrimRight(config.APIURL, "/") + "/api/notify"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create notification request: %w", err)
	}
	request.Header.Set("x-api-key", config.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("send notification: request timed out")
		}
		return fmt.Errorf("send notification: %w", err)
	}
	defer response.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(response.Body, maxErrorBodyBytes+1))
	if readErr != nil {
		return fmt.Errorf("read notification response: %w", readErr)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		detail := safeResponseDetail(body, config.APIKey)
		if detail == "" {
			return fmt.Errorf("notification service returned %s", response.Status)
		}
		return fmt.Errorf("notification service returned %s: %s", response.Status, detail)
	}
	return nil
}

func safeResponseDetail(body []byte, apiKey string) string {
	if len(body) > maxErrorBodyBytes {
		return "response body was too large"
	}
	detail := strings.TrimSpace(string(body))
	if detail == "" {
		return ""
	}
	detail = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) && !unicode.IsSpace(character) {
			return -1
		}
		return character
	}, detail)
	if apiKey != "" {
		detail = strings.ReplaceAll(detail, apiKey, "[redacted]")
	}
	return detail
}

func run(arguments []string) error {
	if len(arguments) == 0 || arguments[0] == "--help" || arguments[0] == "-h" {
		usage()
		return nil
	}
	if len(arguments) == 1 && arguments[0] == "--version" {
		fmt.Println(banner())
		return nil
	}
	if len(arguments) == 1 && arguments[0] == "--configure" {
		return configure()
	}
	if strings.HasPrefix(arguments[0], "-") {
		return fmt.Errorf("unknown option: %s", arguments[0])
	}

	message := strings.TrimSpace(strings.Join(arguments, " "))
	if message == "" {
		return errors.New("the notification message cannot be empty")
	}
	return sendNotification(message)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "notify: %s\n", err)
		os.Exit(1)
	}
}
