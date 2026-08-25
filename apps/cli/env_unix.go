//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// There is no registry to write to, so the closest equivalent to a per-user
// environment is a managed block in the login shell's profile. The markers let
// --configure rewrite its own block without disturbing anything around it.
const (
	profileBlockStart = "# >>> notification-cli >>>"
	profileBlockEnd   = "# <<< notification-cli <<<"
)

func publishEnvironment(config configuration) (string, error) {
	path, err := profilePath()
	if err != nil {
		return "", err
	}

	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read %s: %w", path, err)
	}

	updated := replaceProfileBlock(string(existing), profileBlock(config))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", filepath.Dir(path), err)
	}
	// The block holds the API key, so it is written as privately as the
	// configuration file itself.
	if err := os.WriteFile(path, []byte(updated), 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	return fmt.Sprintf("%s (open a new shell to pick it up)", path), nil
}

func profileBlock(config configuration) string {
	var block strings.Builder
	block.WriteString(profileBlockStart + "\n")
	block.WriteString("# Written by notify --configure for MCP clients. Do not edit.\n")
	for _, variable := range exportedEnvironment(config) {
		fmt.Fprintf(&block, "export %s=%s\n", variable[0], shellQuote(variable[1]))
	}
	block.WriteString(profileBlockEnd + "\n")
	return block.String()
}

// replaceProfileBlock swaps a previously written block for the new one, or
// appends it when there is none, so repeated runs do not stack up exports.
func replaceProfileBlock(existing string, block string) string {
	start := strings.Index(existing, profileBlockStart)
	if start >= 0 {
		if end := strings.Index(existing[start:], profileBlockEnd); end >= 0 {
			tail := existing[start+end+len(profileBlockEnd):]
			return existing[:start] + block + strings.TrimPrefix(tail, "\n")
		}
	}

	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	return existing + block
}

// shellQuote makes a value safe to sit on the right of an export, whatever it
// contains.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// profilePath picks the file the user's login shell actually reads.
func profilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find user home directory: %w", err)
	}

	switch filepath.Base(os.Getenv("SHELL")) {
	case "zsh":
		return filepath.Join(home, ".zprofile"), nil
	case "bash":
		return filepath.Join(home, ".bash_profile"), nil
	default:
		return filepath.Join(home, ".profile"), nil
	}
}
