//go:build !windows

package apps

import (
	"os/exec"
	"syscall"
)

func hideWindow(*exec.Cmd) {}

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
