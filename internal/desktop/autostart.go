package desktop

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// SetLaunchAtLogin makes the app start (hidden, in the tray) when the user signs in, or stops it.
func SetLaunchAtLogin(on bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		file := filepath.Join(home, "Library", "LaunchAgents", "app.proxyapp.desktop.plist")
		if !on {
			return ignoreMissing(os.Remove(file))
		}
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>app.proxyapp.desktop</string>
  <key>ProgramArguments</key><array><string>%s</string><string>--hidden</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`, exe)
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		return os.WriteFile(file, []byte(plist), 0o644)
	case "windows":
		key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
		if on {
			return exec.Command("reg", "add", key, "/v", "Proxy App", "/t", "REG_SZ", "/d", `"`+exe+`" --hidden`, "/f").Run()
		}
		_ = exec.Command("reg", "delete", key, "/v", "Proxy App", "/f").Run()
		return nil
	default:
		file := filepath.Join(home, ".config", "autostart", "proxy-app.desktop")
		if !on {
			return ignoreMissing(os.Remove(file))
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return err
		}
		return os.WriteFile(file, []byte("[Desktop Entry]\nType=Application\nName=Proxy App\nExec=\""+exe+"\" --hidden\n"), 0o644)
	}
}

func ignoreMissing(err error) error {
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
