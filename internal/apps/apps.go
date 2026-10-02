// Package apps finds installed apps, tells which are running, and restarts
// Chromium-based ones with --proxy-server. Apps with their own proxy setting
// get instructions; everything else only follows the system proxy.
package apps

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Scanned is an installed app.
type Scanned struct {
	ID     string
	Name   string
	Path   string // .app bundle on macOS, .exe on Windows
	Exe    string // the process to look for and launch
	Engine string // electron | cef | chromium | native
	Method string // launch | inside | system
	Hint   string
	Icon   string // path to icns/exe, or ""
}

// Process is a running process.
type Process struct {
	PID     int
	Command string
}

func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	return out.String(), err
}

type insideRule struct {
	match *regexp.Regexp
	hint  string
}

// Apps whose traffic is best proxied from their own settings. Matched on bundle id or name.
var inside = []insideRule{
	{regexp.MustCompile(`(?i)telegram`), "Settings → Data and Storage (or Advanced) → Proxy → add SOCKS5, server 127.0.0.1, port {port}."},
	{regexp.MustCompile(`(?i)spotify`), "Settings → Proxy settings → HTTP, host 127.0.0.1, port {port}."},
	{regexp.MustCompile(`(?i)anydesk`), "Settings → Connection → Proxy → use an HTTP proxy, 127.0.0.1 port {port}."},
	{regexp.MustCompile(`(?i)jetbrains|android\.studio|intellij|pycharm|webstorm|goland|phpstorm|rider|clion|datagrip`), "Settings → Appearance & Behavior → System Settings → HTTP Proxy → Manual, 127.0.0.1 port {port}."},
	{regexp.MustCompile(`(?i)adspower|multilogin|gologin|dolphin|incogniton|octo ?browser|morelogin|kameleo|undetectable`), "Add the proxy in each browser profile: HTTP or SOCKS5, 127.0.0.1, port {port} (or an IP’s fixed port)."},
	{regexp.MustCompile(`(?i)qbittorrent|transmission|utorrent|deluge`), "Preferences → Connection → Proxy → SOCKS5, 127.0.0.1 port {port}."},
	{regexp.MustCompile(`(?i)docker`), "Settings → Resources → Proxies → manual, http://127.0.0.1:{port} for both."},
	{regexp.MustCompile(`(?i)postman|insomnia`), "Settings → Proxy → custom proxy, 127.0.0.1 port {port}. Requests you send then go through it."},
}

// Chrome-family browsers and Firefox are handled per profile.
var profileBrowsers = regexp.MustCompile(`(?i)^(com\.google\.chrome|com\.microsoft\.edgemac|com\.brave\.browser|org\.chromium\.chromium|org\.mozilla\.firefox)$|\\(chrome|msedge|brave|firefox)\.exe$`)
var self = regexp.MustCompile(`(?i)app\.proxyapp\.desktop|\\proxy app\.exe$`)

func classify(id, name, engine string) (method, hint string) {
	for _, r := range inside {
		if r.match.MatchString(id) || r.match.MatchString(name) {
			return "inside", r.hint
		}
	}
	if engine != "native" {
		return "launch", ""
	}
	return "system", ""
}

// ---------- macOS ----------

func readPlist(file string) map[string]any {
	out, err := run(15*time.Second, "plutil", "-convert", "json", "-o", "-", file)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(out), &m) != nil {
		return nil
	}
	return m
}

var chromiumFramework = regexp.MustCompile(`(?i)(Chrome|Chromium|Edge|Brave Browser|Opera|Vivaldi|Arc|Yandex) Framework\.framework$`)

func macEngine(bundle string) string {
	entries, err := os.ReadDir(filepath.Join(bundle, "Contents", "Frameworks"))
	if err != nil {
		return "native"
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	for _, n := range names {
		if n == "Electron Framework.framework" {
			return "electron"
		}
	}
	for _, n := range names {
		if n == "Chromium Embedded Framework.framework" {
			return "cef"
		}
	}
	for _, n := range names {
		if chromiumFramework.MatchString(n) {
			return "chromium"
		}
	}
	return "native"
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func scanMac() []Scanned {
	home, _ := os.UserHomeDir()
	dirs := []string{"/Applications", filepath.Join(home, "Applications"), "/System/Applications"}
	var bundles []string
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			n := e.Name()
			switch {
			case strings.HasSuffix(n, ".app"):
				bundles = append(bundles, filepath.Join(dir, n))
			case !strings.HasPrefix(n, ".") && dir != "/System/Applications":
				// One level into folders like /Applications/Utilities or vendor folders.
				subs, err := os.ReadDir(filepath.Join(dir, n))
				if err != nil {
					continue
				}
				for _, s := range subs {
					if strings.HasSuffix(s.Name(), ".app") {
						bundles = append(bundles, filepath.Join(dir, n, s.Name()))
					}
				}
			}
		}
	}
	var mu sync.Mutex
	var out []Scanned
	queue := make(chan string, len(bundles))
	for _, b := range bundles {
		queue <- b
	}
	close(queue)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for b := range queue {
				info := readPlist(filepath.Join(b, "Contents", "Info.plist"))
				exeName := str(info, "CFBundleExecutable")
				if info == nil || exeName == "" {
					continue
				}
				id := str(info, "CFBundleIdentifier")
				if id == "" {
					id = b
				}
				if ui := info["LSUIElement"]; profileBrowsers.MatchString(id) || self.MatchString(id) || ui == true || ui == "1" {
					continue
				}
				name := str(info, "CFBundleDisplayName")
				if name == "" {
					name = str(info, "CFBundleName")
				}
				if name == "" {
					name = strings.TrimSuffix(filepath.Base(b), ".app")
				}
				engine := macEngine(b)
				iconName := str(info, "CFBundleIconFile")
				if iconName == "" {
					iconName = "AppIcon"
				}
				if !strings.HasSuffix(iconName, ".icns") {
					iconName += ".icns"
				}
				icon := filepath.Join(b, "Contents", "Resources", iconName)
				if _, err := os.Stat(icon); err != nil {
					icon = ""
				}
				method, hint := classify(id, name, engine)
				mu.Lock()
				out = append(out, Scanned{ID: id, Name: name, Path: b, Exe: filepath.Join(b, "Contents", "MacOS", exeName), Engine: engine, Method: method, Hint: hint, Icon: icon})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return dedupe(out)
}

// ---------- Windows ----------

var uninstallKeys = []string{
	`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
	`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall`,
	`HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
}

func winEngine(exe string) string {
	dir := filepath.Dir(exe)
	has := func(p string) bool { _, err := os.Stat(filepath.Join(dir, p)); return err == nil }
	switch {
	case has(`resources\app.asar`) || has(`resources\app`) || has(`resources\electron.asar`):
		return "electron"
	case has("libcef.dll"):
		return "cef"
	case regexp.MustCompile(`(?i)\\(opera|vivaldi|yandex|chromium)\.exe$`).MatchString(exe) || has("chrome_100_percent.pak"):
		return "chromium"
	}
	return "native"
}

var appVersionDir = regexp.MustCompile(`^app-\d`)
var numRun = regexp.MustCompile(`\d+|\D+`)

// numericLess compares like localeCompare(..., {numeric: true}).
func numericLess(a, b string) bool {
	pa, pb := numRun.FindAllString(a, -1), numRun.FindAllString(b, -1)
	for i := 0; i < len(pa) && i < len(pb); i++ {
		x, y := pa[i], pb[i]
		nx, ex := strconv.Atoi(x)
		ny, ey := strconv.Atoi(y)
		if ex == nil && ey == nil {
			if nx != ny {
				return nx < ny
			}
			continue
		}
		if x != y {
			return strings.ToLower(x) < strings.ToLower(y)
		}
	}
	return len(pa) < len(pb)
}

// Squirrel installers (Slack, Discord…) keep the real exe in the newest app-x.y.z folder.
func squirrelExe(root, name string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	var versions []string
	for _, e := range entries {
		if appVersionDir.MatchString(e.Name()) {
			versions = append(versions, e.Name())
		}
	}
	if len(versions) == 0 {
		return ""
	}
	sort.Slice(versions, func(i, j int) bool { return numericLess(versions[i], versions[j]) })
	latest := versions[len(versions)-1]
	files, err := os.ReadDir(filepath.Join(root, latest))
	if err != nil {
		return ""
	}
	skip := regexp.MustCompile(`(?i)squirrel|update`)
	var exes []string
	for _, f := range files {
		if strings.HasSuffix(strings.ToLower(f.Name()), ".exe") && !skip.MatchString(f.Name()) {
			exes = append(exes, f.Name())
		}
	}
	if len(exes) == 0 {
		return ""
	}
	first := strings.ToLower(strings.Split(name, " ")[0])
	best := exes[0]
	for _, f := range exes {
		if strings.HasPrefix(strings.ToLower(f), first) {
			best = f
			break
		}
	}
	return filepath.Join(root, latest, best)
}

var (
	winBlockSplit = regexp.MustCompile(`\r?\n\r?\n`)
	winBadName    = regexp.MustCompile(`(?i)update|redistributable|runtime|driver|sdk`)
	winBadExe     = regexp.MustCompile(`(?i)uninst|update\.exe`)
	winIconClean  = regexp.MustCompile(`^"|"?,-?\d+$|"$`)
	winQuotes     = regexp.MustCompile(`^"|"$`)
)

func regVal(block, name string) string {
	m := regexp.MustCompile(`(?m)^\s+` + name + `\s+REG_\w+\s+(.+)$`).FindStringSubmatch(block)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func scanWindows() []Scanned {
	var out []Scanned
	for _, key := range uninstallKeys {
		text, err := run(15*time.Second, "reg", "query", key, "/s")
		if err != nil {
			continue
		}
		for _, block := range winBlockSplit.Split(text, -1) {
			name := regVal(block, "DisplayName")
			if name == "" || regVal(block, "SystemComponent") == "0x1" || winBadName.MatchString(name) {
				continue
			}
			icon := winIconClean.ReplaceAllString(regVal(block, "DisplayIcon"), "")
			location := winQuotes.ReplaceAllString(regVal(block, "InstallLocation"), "")
			exe := ""
			if strings.HasSuffix(strings.ToLower(icon), ".exe") && !winBadExe.MatchString(icon) {
				exe = icon
			}
			if exe == "" && location != "" {
				exe = squirrelExe(location, name)
			}
			if exe == "" {
				continue
			}
			if _, err := os.Stat(exe); err != nil {
				continue
			}
			id := strings.ToLower(exe)
			if profileBrowsers.MatchString(id) || self.MatchString(id) {
				continue
			}
			engine := winEngine(exe)
			method, hint := classify(id, name, engine)
			out = append(out, Scanned{ID: id, Name: name, Path: exe, Exe: exe, Engine: engine, Method: method, Hint: hint, Icon: exe})
		}
	}
	return dedupe(out)
}

func dedupe(apps []Scanned) []Scanned {
	seen := map[string]bool{}
	out := []Scanned{}
	for _, a := range apps {
		if !seen[a.ID] {
			seen[a.ID] = true
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].Name < out[j].Name
	})
	return out
}

var (
	cacheMu sync.Mutex
	cacheAt time.Time
	cache   []Scanned
)

// Scan lists installed apps. Scanning takes about a second, so results are kept for a minute.
func Scan(force bool) []Scanned {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	if !force && cache != nil && time.Since(cacheAt) < time.Minute {
		return cache
	}
	apps := []Scanned{}
	switch runtime.GOOS {
	case "darwin":
		apps = scanMac()
	case "windows":
		apps = scanWindows()
	}
	cache, cacheAt = apps, time.Now()
	return apps
}

// ---------- processes ----------

var psLine = regexp.MustCompile(`^(\d+)\s+(.*)$`)

// ListProcesses returns running processes with their command lines.
func ListProcesses() []Process {
	if runtime.GOOS == "windows" {
		out, err := run(15*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
			"Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress")
		if err != nil {
			return nil
		}
		return parseWinProcesses(out)
	}
	out, err := run(15*time.Second, "ps", "-axww", "-o", "pid=,command=")
	if err != nil {
		return nil
	}
	return parsePS(out)
}

func parsePS(out string) []Process {
	var procs []Process
	for _, l := range strings.Split(out, "\n") {
		m := psLine.FindStringSubmatch(strings.TrimSpace(l))
		if m == nil {
			continue
		}
		pid, _ := strconv.Atoi(m[1])
		procs = append(procs, Process{PID: pid, Command: m[2]})
	}
	return procs
}

func parseWinProcesses(js string) []Process {
	type row struct {
		ProcessID      int     `json:"ProcessId"`
		CommandLine    *string `json:"CommandLine"`
		ExecutablePath *string `json:"ExecutablePath"`
	}
	js = strings.TrimSpace(js)
	if js == "" {
		return nil
	}
	var rows []row
	if err := json.Unmarshal([]byte(js), &rows); err != nil {
		var one row
		if err := json.Unmarshal([]byte(js), &one); err != nil {
			return nil
		}
		rows = []row{one}
	}
	procs := make([]Process, 0, len(rows))
	for _, r := range rows {
		cmd := ""
		if r.CommandLine != nil && *r.CommandLine != "" {
			cmd = *r.CommandLine
		} else if r.ExecutablePath != nil {
			cmd = *r.ExecutablePath
		}
		procs = append(procs, Process{PID: r.ProcessID, Command: cmd})
	}
	return procs
}

// FindMain returns the app's main process (not helpers), if it is running.
func FindMain(app Scanned, procs []Process) *Process {
	exe := strings.ToLower(app.Exe)
	for i := range procs {
		cmd := strings.TrimPrefix(strings.ToLower(procs[i].Command), `"`)
		// Electron/Chromium children carry --type=renderer|gpu-process|utility…
		if strings.HasPrefix(cmd, exe) && !hasTypeFlag(cmd) {
			return &procs[i]
		}
	}
	return nil
}

var typeFlag = regexp.MustCompile(`\s--type=`)

func hasTypeFlag(cmd string) bool { return typeFlag.MatchString(cmd) }

var proxyFlag = regexp.MustCompile(`--proxy-server=(?:https?://)?127\.0\.0\.1:(\d+)`)

// ProxyPortOf returns the gateway port a running app was started with, or nil.
func ProxyPortOf(p *Process) *int {
	if p == nil {
		return nil
	}
	m := proxyFlag.FindStringSubmatch(p.Command)
	if m == nil {
		return nil
	}
	n, _ := strconv.Atoi(m[1])
	return &n
}

// ProxyArgs are the launch arguments that point a Chromium app at the gateway.
func ProxyArgs(port int) []string {
	return []string{fmt.Sprintf("--proxy-server=http://127.0.0.1:%d", port)}
}

// QuitApp asks the app to quit (Chromium apps treat SIGTERM / WM_CLOSE as a normal quit) and waits.
func QuitApp(app Scanned, timeout time.Duration) bool {
	main := FindMain(app, ListProcesses())
	if main == nil {
		return true
	}
	if runtime.GOOS == "windows" {
		run(15*time.Second, "taskkill", "/PID", strconv.Itoa(main.PID), "/T")
	} else if p, err := os.FindProcess(main.PID); err == nil {
		p.Signal(syscall.SIGTERM)
	}
	until := time.Now().Add(timeout)
	for time.Now().Before(until) {
		time.Sleep(400 * time.Millisecond)
		if FindMain(app, ListProcesses()) == nil {
			return true
		}
	}
	return false
}

// cleanEnv drops variables that would make an Electron app start as bare Node.
func cleanEnv() []string {
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "ELECTRON_RUN_AS_NODE=") || strings.HasPrefix(e, "ELECTRON_NO_ATTACH_CONSOLE=") {
			continue
		}
		env = append(env, e)
	}
	return env
}

func spawnDetached(cmd *exec.Cmd) {
	detach(cmd)
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
}

// LaunchApp starts the app detached with the given arguments.
func LaunchApp(app Scanned, args []string) {
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		argv := []string{"-a", app.Path}
		if len(args) > 0 {
			argv = append(argv, "--args")
			argv = append(argv, args...)
		}
		cmd = exec.Command("open", argv...)
	} else {
		cmd = exec.Command(app.Exe, args...)
	}
	cmd.Dir = filepath.Dir(app.Exe)
	cmd.Env = cleanEnv()
	spawnDetached(cmd)
}

// ---------- icons ----------

// Icon returns a 64px PNG for the list, cached under cacheDir.
func Icon(app Scanned, cacheDir string) ([]byte, error) {
	sum := sha1.Sum([]byte(app.Path))
	file := filepath.Join(cacheDir, hex.EncodeToString(sum[:])[:16]+".png")
	if b, err := os.ReadFile(file); err == nil {
		return b, nil
	}
	if app.Icon == "" {
		return nil, errors.New("no icon")
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return nil, err
	}
	switch runtime.GOOS {
	case "darwin":
		if _, err := run(15*time.Second, "sips", "-s", "format", "png", "-Z", "64", app.Icon, "--out", file); err != nil {
			return nil, err
		}
	case "windows":
		q := func(s string) string { return strings.ReplaceAll(s, "'", "''") }
		ps := fmt.Sprintf("Add-Type -AssemblyName System.Drawing; [System.Drawing.Icon]::ExtractAssociatedIcon('%s').ToBitmap().Save('%s', [System.Drawing.Imaging.ImageFormat]::Png)", q(app.Icon), q(file))
		if _, err := run(15*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("icons are not supported on this platform")
	}
	return os.ReadFile(file)
}

// ---------- terminal ----------

// OpenProxyTerminal opens a terminal window whose commands and scripts use the gateway.
func OpenProxyTerminal(port int, dataDir string) {
	httpURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	socks := fmt.Sprintf("socks5h://127.0.0.1:%d", port)
	switch runtime.GOOS {
	case "darwin":
		file := filepath.Join(dataDir, "proxy-terminal.command")
		script := fmt.Sprintf(`#!/bin/zsh
export HTTP_PROXY=%[1]s HTTPS_PROXY=%[1]s ALL_PROXY=%[2]s
export http_proxy=%[1]s https_proxy=%[1]s all_proxy=%[2]s
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
clear
echo "Proxy App: commands in this window use 127.0.0.1:%[3]d."
echo "Check with: curl https://api.ipify.org"
exec $SHELL -l
`, httpURL, socks, port)
		os.MkdirAll(dataDir, 0o755)
		if os.WriteFile(file, []byte(script), 0o700) != nil {
			return
		}
		os.Chmod(file, 0o700)
		spawnDetached(exec.Command("open", file))
	case "windows":
		env := fmt.Sprintf("$env:HTTP_PROXY='%[1]s'; $env:HTTPS_PROXY='%[1]s'; $env:ALL_PROXY='%[2]s'; $env:NO_PROXY='localhost,127.0.0.1'; Write-Host 'Proxy App: commands in this window use 127.0.0.1:%[3]d.'", httpURL, socks, port)
		spawnDetached(exec.Command("cmd.exe", "/c", "start", "powershell.exe", "-NoExit", "-Command", env))
	default:
		spawnDetached(exec.Command("x-terminal-emulator", "-e", fmt.Sprintf("env HTTP_PROXY=%[1]s HTTPS_PROXY=%[1]s ALL_PROXY=%[2]s $SHELL", httpURL, socks)))
	}
}
