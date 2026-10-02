package desktop

import (
	"os/exec"
	"runtime"

	"github.com/big-forge/big-proxy/internal/browsers"
)

// OpenWindow shows the UI as a standalone app window using a Chromium-based browser
// that is already installed (Chrome, Edge, Brave), so no browser engine ships with the app.
// Without one it falls back to a normal tab in the default browser.
func OpenWindow(url string) {
	for _, id := range []string{"chrome", "edge", "brave", "chromium"} {
		app := browsers.BrowserApp(id)
		if app == nil {
			continue
		}
		args := []string{"--app=" + url, "--window-size=1120,780"}
		var cmd *exec.Cmd
		if runtime.GOOS == "darwin" {
			// -n: a new launch request, so the flags reach a browser that is already running.
			cmd = exec.Command("open", append([]string{"-na", app.Path, "--args"}, args...)...)
		} else {
			cmd = exec.Command(app.Exe, args...)
		}
		if cmd.Start() == nil {
			go func() { _ = cmd.Wait() }()
			return
		}
	}
	openDefault(url)
}

func openDefault(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if cmd.Start() == nil {
		go func() { _ = cmd.Wait() }()
	}
}
