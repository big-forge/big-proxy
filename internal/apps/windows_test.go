package apps

import (
	"runtime"
	"testing"
)

// Runs on the Windows CI machine only.
func TestWindowsAppsAndProcesses(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	list := Scan(true)
	t.Logf("found %d apps", len(list))
	if len(ListProcesses()) == 0 {
		t.Fatal("process list should not be empty")
	}
}
