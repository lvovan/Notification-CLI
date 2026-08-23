package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	apiURLEnvironmentVariable = "NOTIFICATION_CLI_API_URL"
	apiKeyEnvironmentVariable = "NOTIFICATION_CLI_API_KEY"
)

type configuration struct {
	APIURL string `json:"apiUrl"`
	APIKey string `json:"apiKey"`
}

func configurationPath() (string, error) {
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", fmt.Errorf("find user home directory: %w", err)
			}
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "Notification CLI", "config.json"), nil
	}

	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		var err error
		base, err = os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("find user configuration directory: %w", err)
		}
	}
	return filepath.Join(base, "notification-cli", "config.json"), nil
}

func validateAPIURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", errors.New("the API URL must be an absolute URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("the API URL must not contain credentials, a query, or a fragment")
	}

	hostname := parsed.Hostname()
	isLocal := strings.EqualFold(hostname, "localhost")
	if ip := net.ParseIP(hostname); ip != nil {
		isLocal = ip.IsLoopback()
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLocal) {
		return "", errors.New("the API URL must use HTTPS (HTTP is allowed only for localhost)")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}

func validateAPIKey(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("the API key cannot be empty")
	}
	if len(value) > 8192 {
		return errors.New("the API key is too long")
	}
	if strings.ContainsAny(value, "\r\n") {
		return errors.New("the API key contains invalid characters")
	}
	return nil
}

func validateConfiguration(config configuration) (configuration, error) {
	apiURL, err := validateAPIURL(config.APIURL)
	if err != nil {
		return configuration{}, err
	}
	if err := validateAPIKey(config.APIKey); err != nil {
		return configuration{}, err
	}
	config.APIURL = apiURL
	return config, nil
}

func saveConfiguration(config configuration, path string) error {
	config, err := validateConfiguration(config)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}

	content, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode configuration: %w", err)
	}
	content = append(content, '\n')

	temporaryPath := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(temporaryPath, content, 0o600); err != nil {
		return fmt.Errorf("write configuration: %w", err)
	}
	defer os.Remove(temporaryPath)

	if runtime.GOOS == "windows" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("replace configuration: %w", err)
		}
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("save configuration: %w", err)
	}
	return nil
}

func loadConfiguration(path string) (configuration, error) {
	apiURL := strings.TrimSpace(os.Getenv(apiURLEnvironmentVariable))
	apiKey := os.Getenv(apiKeyEnvironmentVariable)
	if apiURL != "" || apiKey != "" {
		if apiURL == "" || apiKey == "" {
			return configuration{}, fmt.Errorf(
				"both %s and %s must be set",
				apiURLEnvironmentVariable,
				apiKeyEnvironmentVariable,
			)
		}
		return validateConfiguration(configuration{APIURL: apiURL, APIKey: apiKey})
	}

	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return configuration{}, configurationInstructions()
	}
	if err != nil {
		return configuration{}, fmt.Errorf("read configuration: %w", err)
	}

	var config configuration
	if err := json.Unmarshal(content, &config); err != nil {
		return configuration{}, fmt.Errorf("parse configuration: %w", err)
	}
	config, err = validateConfiguration(config)
	if err != nil {
		return configuration{}, fmt.Errorf("saved configuration is invalid or obsolete: %w; %w", err, configurationInstructions())
	}
	return config, nil
}

func configurationInstructions() error {
	return fmt.Errorf(
		"Notification CLI is not configured; set %s and %s in your environment, then run \"notify --configure\"",
		apiURLEnvironmentVariable,
		apiKeyEnvironmentVariable,
	)
}
