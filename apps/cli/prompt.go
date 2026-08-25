package main

import (
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/erikgeiser/promptkit"
	"github.com/erikgeiser/promptkit/textinput"
	"golang.org/x/term"
)

// errNoTerminal explains the one situation the prompts cannot serve: there is
// nowhere to ask the question, and with the environment variables gone there is
// nothing left to fall back on.
var errNoTerminal = errors.New(
	"--configure needs an interactive terminal; run it directly instead of through a pipe or a script",
)

// prompter is where the questions are asked. The prompt is drawn on stderr so
// the outcome printed on stdout stays pipeable on its own.
type prompter struct {
	input  io.Reader
	output io.Writer
}

func consolePrompter() (prompter, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return prompter{}, errNoTerminal
	}
	return prompter{input: os.Stdin, output: os.Stderr}, nil
}

// question is one thing --configure needs to know. Keeping them as values lets
// each prompt, and its validation, be driven on its own.
type question struct {
	label    string
	initial  string
	hidden   bool
	validate func(string) error
}

// The URL is offered as an editable default so re-configuring only means
// confirming it.
func urlQuestion(current string) question {
	return question{
		label:   "Service URL:",
		initial: current,
		validate: func(value string) error {
			_, err := validateAPIURL(value)
			return err
		},
	}
}

// The key is always retyped and never displayed: it is a secret, so the saved
// copy is not offered back as a default.
func keyQuestion() question {
	return question{label: "API key:", hidden: true, validate: validateAPIKey}
}

// promptedConfiguration asks for the service URL and the API key.
func (p prompter) promptedConfiguration(current configuration) (configuration, error) {
	apiURL, err := p.ask(urlQuestion(current.APIURL))
	if err != nil {
		return configuration{}, err
	}

	apiKey, err := p.ask(keyQuestion())
	if err != nil {
		return configuration{}, err
	}

	return validateConfiguration(configuration{APIURL: apiURL, APIKey: apiKey})
}

func (p prompter) ask(q question) (string, error) {
	input := textinput.New(q.label)
	input.InitialValue = q.initial
	input.Hidden = q.hidden
	input.Validate = q.validate
	input.Input = p.input
	input.Output = p.output

	value, err := input.RunPrompt()
	if err != nil {
		// Ctrl+C is a decision, not a failure worth an error message.
		if errors.Is(err, promptkit.ErrAborted) || errors.Is(err, io.EOF) {
			return "", errAborted
		}
		return "", fmt.Errorf("read %q: %w", q.label, err)
	}
	return value, nil
}
