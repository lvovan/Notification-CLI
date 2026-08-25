package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// publishEnvironment writes the MCP variables to the per-user environment in
// the registry, which is what "user scope" means on Windows.
func publishEnvironment(config configuration) (string, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, "Environment", registry.SET_VALUE)
	if err != nil {
		return "", fmt.Errorf("open the user environment: %w", err)
	}
	defer key.Close()

	for _, variable := range exportedEnvironment(config) {
		if err := key.SetStringValue(variable[0], variable[1]); err != nil {
			return "", fmt.Errorf("set %s: %w", variable[0], err)
		}
	}

	announceEnvironmentChange()
	return "user environment (restart open terminals to pick it up)", nil
}

// announceEnvironmentChange tells already-running programs to reload the
// environment. Without it a change is only visible to processes started after
// the next sign-in. A failure here costs nothing but that immediacy, so it is
// deliberately not reported.
func announceEnvironmentChange() {
	const (
		hwndBroadcast   = 0xFFFF
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
		timeoutMs       = 1000
	)

	subject, err := windows.UTF16PtrFromString("Environment")
	if err != nil {
		return
	}
	var result uintptr
	_, _, _ = windows.NewLazySystemDLL("user32.dll").
		NewProc("SendMessageTimeoutW").
		Call(
			hwndBroadcast,
			wmSettingChange,
			0,
			uintptr(unsafe.Pointer(subject)),
			smtoAbortIfHung,
			timeoutMs,
			uintptr(unsafe.Pointer(&result)),
		)
}
