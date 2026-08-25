package main

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// keystrokes feeds one prompt, one key at a time: a whole burst would be parsed
// as a paste rather than as the key presses the prompt reacts to. Each prompt
// gets its own reader, because the reader goroutine of a finished Bubble Tea
// program stays parked in Read and would swallow the next prompt's first key.
type keystrokes struct {
	mutex     sync.Mutex
	remaining string
}

func (k *keystrokes) Read(p []byte) (int, error) {
	k.mutex.Lock()
	defer k.mutex.Unlock()

	if k.remaining == "" {
		return 0, io.EOF
	}
	p[0] = k.remaining[0]
	k.remaining = k.remaining[1:]
	return 1, nil
}

// answer drives a real prompt with real keystrokes and reports what it yields
// along with everything it drew on screen.
func answer(t *testing.T, q question, typed string) (string, string, error) {
	t.Helper()

	output := &bytes.Buffer{}
	prompts := prompter{input: &keystrokes{remaining: typed}, output: output}

	type outcome struct {
		value string
		err   error
	}
	results := make(chan outcome, 1)
	go func() {
		value, err := prompts.ask(q)
		results <- outcome{value, err}
	}()

	select {
	case result := <-results:
		return result.value, output.String(), result.err
	case <-time.After(20 * time.Second):
		t.Fatal("the prompt did not finish")
		return "", "", nil
	}
}

func TestURLPromptAccepts(t *testing.T) {
	value, _, err := answer(t, urlQuestion(""), "https://example.com\r")
	if err != nil {
		t.Fatalf("prompt for the URL: %v", err)
	}
	if value != "https://example.com" {
		t.Fatalf("got %q", value)
	}
}

// The saved URL is offered as an editable default, so re-configuring is a
// matter of confirming it.
func TestURLPromptOffersTheCurrentValue(t *testing.T) {
	value, _, err := answer(t, urlQuestion("https://saved.example"), "\r")
	if err != nil {
		t.Fatalf("prompt for the URL: %v", err)
	}
	if value != "https://saved.example" {
		t.Fatalf("got %q, want the saved URL", value)
	}
}

// Validation refuses to submit, so a bad answer leaves the prompt where it is
// instead of saving settings that cannot work.
func TestPromptsRefuseToSubmitInvalidInput(t *testing.T) {
	erase := func(text string) string { return strings.Repeat("\x7f", len(text)) }

	t.Run("insecure URL", func(t *testing.T) {
		typed := "http://example.com\r" + erase("http://example.com") + "https://example.com\r"
		value, _, err := answer(t, urlQuestion(""), typed)
		if err != nil {
			t.Fatalf("prompt for the URL: %v", err)
		}
		if value != "https://example.com" {
			t.Fatalf("got %q; the insecure URL should not have submitted", value)
		}
	})

	t.Run("unprefixed key", func(t *testing.T) {
		typed := "secret\r" + erase("secret") + testAPIKey + "\r"
		value, _, err := answer(t, keyQuestion(), typed)
		if err != nil {
			t.Fatalf("prompt for the key: %v", err)
		}
		if value != testAPIKey {
			t.Fatalf("got %q; the unprefixed key should not have submitted", value)
		}
	})
}

func TestKeyPromptHidesTheSecret(t *testing.T) {
	if !keyQuestion().hidden {
		t.Fatal("the API key prompt is not hidden")
	}
	// A default would put a previously saved key back on screen.
	if keyQuestion().initial != "" {
		t.Fatal("the API key prompt offers a default")
	}

	value, screen, err := answer(t, keyQuestion(), testAPIKey+"\r")
	if err != nil {
		t.Fatalf("prompt for the key: %v", err)
	}
	if value != testAPIKey {
		t.Fatalf("got %q", value)
	}
	if strings.Contains(screen, apiKeyPrefix) {
		t.Fatal("the prompt echoed the API key")
	}
}

func TestPromptsReportAbort(t *testing.T) {
	// Ctrl+C.
	if _, _, err := answer(t, urlQuestion(""), "\x03"); !errors.Is(err, errAborted) {
		t.Fatalf("expected an abort, got %v", err)
	}
}

// go test runs without a terminal, which is exactly the case the guard exists
// for now that there is no environment variable to fall back on.
func TestConsolePrompterRequiresATerminal(t *testing.T) {
	if _, err := consolePrompter(); !errors.Is(err, errNoTerminal) {
		t.Fatalf("expected the no-terminal guard to fire, got %v", err)
	}
}
