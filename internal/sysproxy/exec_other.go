//go:build !windows

package sysproxy

import "os/exec"

func hideWindow(*exec.Cmd) {}
