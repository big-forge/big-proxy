//go:build windows

package apps

import (
	"os/exec"
	"syscall"
)

const (
	createNoWindow      = 0x08000000
	detachedProcess     = 0x00000008
	createNewProcessGrp = 0x00000200
)

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGrp}
}
