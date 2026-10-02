// Package sysproxy points the operating system's proxy settings at the local
// gateway and puts the user's previous settings back afterwards.
package sysproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Snapshot is whatever a driver needs to put the user's previous settings back.
type Snapshot struct {
	Platform string          `json:"platform"`
	Data     json.RawMessage `json:"data"`
}

// Driver applies and restores the system proxy.
type Driver interface {
	Apply(host string, port int, bypass []string) (Snapshot, error)
	Restore(Snapshot) error
}

// ForPlatform returns the driver for this OS, or nil when unsupported.
func ForPlatform() Driver {
	switch runtime.GOOS {
	case "darwin":
		return darwinDriver{}
	case "windows":
		return windowsDriver{}
	case "linux":
		return linuxDriver{}
	}
	return nil
}

// Run executes a command with a 15s timeout and returns stdout. On failure the
// error message is the trimmed stderr (or the exec error when stderr is empty).
func Run(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.String(), errors.New(msg)
	}
	return stdout.String(), nil
}
