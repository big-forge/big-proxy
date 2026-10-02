// Package browsers finds browser profiles, tells whether our extension is in
// each, and switches a profile's proxy.
//
// Chrome-family browsers share one process for all profiles, so a per-profile
// proxy comes either from an extension installed in that profile or from the
// profile's own Preferences file (browser closed). Firefox reads a managed
// block in user.js at every start.
package browsers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/big-forge/big-proxy/internal/apps"
	"github.com/big-forge/big-proxy/internal/types"
)

type browserDef struct {
	id, name string
	// user data folder per platform, relative to the matching base
	dataDarwin, dataWindows, dataLinux string
	// macOS app bundle, Windows exe (relative to Program Files / LocalAppData), Linux command
	appDarwin, appWindows, appLinux string
	macExe                          string
}

var chromeFamily = []browserDef{
	{"chrome", "Chrome", "Google/Chrome", `Google\Chrome\User Data`, "google-chrome", "Google Chrome.app", `Google\Chrome\Application\chrome.exe`, "google-chrome", "Google Chrome"},
	{"edge", "Edge", "Microsoft Edge", `Microsoft\Edge\User Data`, "microsoft-edge", "Microsoft Edge.app", `Microsoft\Edge\Application\msedge.exe`, "microsoft-edge", "Microsoft Edge"},
	{"brave", "Brave", "BraveSoftware/Brave-Browser", `BraveSoftware\Brave-Browser\User Data`, "BraveSoftware/Brave-Browser", "Brave Browser.app", `BraveSoftware\Brave-Browser\Application\brave.exe`, "brave-browser", "Brave Browser"},
	{"chromium", "Chromium", "Chromium", `Chromium\User Data`, "chromium", "Chromium.app", `Chromium\Application\chrome.exe`, "chromium", "Chromium"},
}

func find(id string) *browserDef {
	for i := range chromeFamily {
		if chromeFamily[i].id == id {
			return &chromeFamily[i]
		}
	}
	return nil
}

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

func userDataDir(b *browserDef) string {
	home := homeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", filepath.FromSlash(b.dataDarwin))
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, b.dataWindows)
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, filepath.FromSlash(b.dataLinux))
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func findApp(b *browserDef) string {
	switch runtime.GOOS {
	case "darwin":
		for _, p := range []string{filepath.Join("/Applications", b.appDarwin), filepath.Join(homeDir(), "Applications", b.appDarwin)} {
			if exists(p) {
				return p
			}
		}
		return ""
	case "windows":
		for _, r := range []string{os.Getenv("PROGRAMFILES"), os.Getenv("PROGRAMFILES(X86)"), os.Getenv("LOCALAPPDATA")} {
			if r == "" {
				continue
			}
			if p := filepath.Join(r, b.appWindows); exists(p) {
				return p
			}
		}
		return ""
	}
	return b.appLinux
}

// readJSON decodes a file into generic values, keeping numbers exact. nil on any failure.
func readJSON(file string) map[string]any {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var m map[string]any
	if dec.Decode(&m) != nil {
		return nil
	}
	return m
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }

func nonEmpty(v any) string { s, _ := v.(string); return s }

// extensionState reads Chrome's record of unpacked extensions in each profile's Secure Preferences.
func extensionState(profileDir, extensionDir string) string {
	want, err := filepath.Abs(extensionDir)
	if err != nil {
		want = extensionDir
	}
	for _, file := range []string{"Secure Preferences", "Preferences"} {
		settings := obj(obj(readJSON(filepath.Join(profileDir, file))["extensions"])["settings"])
		for _, v := range settings {
			ext := obj(v)
			p, ok := ext["path"].(string)
			if !ok {
				continue
			}
			if got, err := filepath.Abs(p); err != nil || got != want {
				continue
			}
			if reasons, ok := ext["disable_reasons"].([]any); ok {
				if len(reasons) > 0 {
					return "disabled"
				}
				return "on"
			}
			if n, ok := ext["state"].(json.Number); ok && n.String() == "0" {
				return "disabled"
			}
			return "on"
		}
	}
	return "missing"
}

// ListProfiles lists Chrome-family and Firefox profiles.
func ListProfiles(extensionDir string) []types.BrowserProfile {
	out := []types.BrowserProfile{}
	for i := range chromeFamily {
		b := &chromeFamily[i]
		dataDir := userDataDir(b)
		info := obj(readJSON(filepath.Join(dataDir, "Local State"))["profile"])
		cache := obj(info["info_cache"])
		if cache == nil {
			continue
		}
		var dirs []string
		seen := map[string]bool{}
		add := func(d string) {
			if seen[d] {
				return
			}
			seen[d] = true
			if cache[d] != nil && exists(filepath.Join(dataDir, d)) {
				dirs = append(dirs, d)
			}
		}
		if order, ok := info["profiles_order"].([]any); ok {
			for _, d := range order {
				if s, ok := d.(string); ok {
					add(s)
				}
			}
		} else {
			for d := range cache {
				add(d)
			}
		}
		// Keys missing from profiles_order still count, in a stable order.
		rest := make([]string, 0, len(cache))
		for d := range cache {
			rest = append(rest, d)
		}
		sortStrings(rest)
		for _, d := range rest {
			add(d)
		}
		for _, dir := range dirs {
			p := obj(cache[dir])
			name := nonEmpty(p["name"])
			if name == "" {
				name = nonEmpty(p["gaia_name"])
			}
			if name == "" {
				name = dir
			}
			pdir := filepath.Join(dataDir, dir)
			out = append(out, types.BrowserProfile{
				Browser:     b.id,
				BrowserName: b.name,
				Dir:         dir,
				Name:        name,
				Email:       nonEmpty(p["user_name"]),
				Kind:        "extension",
				Extension:   extensionState(pdir, extensionDir),
				ProxyPort:   PrefsProxyPort(pdir),
			})
		}
	}
	return append(out, ListFirefoxProfiles(FirefoxRoot())...)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ---------- Firefox ----------

const (
	beginMark = "// BEGIN Proxy App (managed by Proxy App, do not edit)"
	endMark   = "// END Proxy App"
)

// FirefoxRoot is Firefox's profile root for this OS.
func FirefoxRoot() string {
	home := homeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Firefox")
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Mozilla", "Firefox")
	}
	return filepath.Join(home, ".mozilla", "firefox")
}

var (
	profileSection = regexp.MustCompile(`^Profile\d+\]`)
	sectionSplit   = regexp.MustCompile(`(?m)^\[`)
	notRelative    = regexp.MustCompile(`(?m)^IsRelative=0\s*$`)
)

func iniGet(section, key string) string {
	m := regexp.MustCompile(`(?m)^` + key + `=(.*)$`).FindStringSubmatch(section)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func firefoxProfileFolder(root, section, dir string) string {
	if notRelative.MatchString(section) {
		return dir
	}
	return filepath.Join(root, filepath.FromSlash(dir))
}

// ListFirefoxProfiles reads profiles.ini. Dir is the Path entry, which is also how we address the profile.
func ListFirefoxProfiles(root string) []types.BrowserProfile {
	data, err := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return nil
	}
	var out []types.BrowserProfile
	for _, section := range sectionSplit.Split(string(data), -1) {
		if !profileSection.MatchString(section) {
			continue
		}
		dir := iniGet(section, "Path")
		if dir == "" {
			continue
		}
		folder := firefoxProfileFolder(root, section, dir)
		if !exists(folder) {
			continue
		}
		name := iniGet(section, "Name")
		if name == "" {
			name = dir
		}
		out = append(out, types.BrowserProfile{Browser: "firefox", BrowserName: "Firefox", Dir: dir, Name: name, Kind: "prefs", Extension: firefoxState(folder)})
	}
	return out
}

var firefoxOn = regexp.MustCompile(`"network\.proxy\.type",\s*1\)`)

func firefoxState(folder string) string {
	data, err := os.ReadFile(filepath.Join(folder, "user.js"))
	if err != nil {
		return "missing"
	}
	js := string(data)
	start := strings.Index(js, beginMark)
	if start < 0 {
		return "missing"
	}
	block := js[start:]
	if end := strings.Index(js, endMark); end > start {
		block = js[start:end]
	}
	if firefoxOn.MatchString(block) {
		return "on"
	}
	return "missing"
}

// SetFirefoxProxy writes (port) or resets (nil) our block in the profile's user.js.
// Firefox applies it on its next start.
func SetFirefoxProxy(dir string, port *int) error {
	return setFirefoxProxyIn(FirefoxRoot(), dir, port)
}

func setFirefoxProxyIn(root, dir string, port *int) error {
	found := false
	for _, p := range ListFirefoxProfiles(root) {
		if p.Dir == dir {
			found = true
		}
	}
	if !found {
		return errors.New("That Firefox profile was not found")
	}
	ini, err := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return err
	}
	section := ""
	for _, s := range sectionSplit.Split(string(ini), -1) {
		if iniGet(s, "Path") == dir {
			section = s
			break
		}
	}
	file := filepath.Join(firefoxProfileFolder(root, section, dir), "user.js")
	var js string
	if data, err := os.ReadFile(file); err == nil {
		js = string(data)
	}
	start, end := strings.Index(js, beginMark), strings.Index(js, endMark)
	if start != -1 && end > start {
		tail := js[end+len(endMark):]
		tail = strings.TrimPrefix(strings.TrimPrefix(tail, "\r"), "\n")
		js = js[:start] + tail
	}
	var prefs []string
	if port == nil {
		// Back to Firefox's default ("use system proxy settings"); prefs.js would otherwise keep ours.
		prefs = []string{`user_pref("network.proxy.type", 5);`}
	} else {
		prefs = []string{
			`user_pref("network.proxy.type", 1);`,
			`user_pref("network.proxy.http", "127.0.0.1");`,
			fmt.Sprintf(`user_pref("network.proxy.http_port", %d);`, *port),
			`user_pref("network.proxy.ssl", "127.0.0.1");`,
			fmt.Sprintf(`user_pref("network.proxy.ssl_port", %d);`, *port),
			`user_pref("network.proxy.share_proxy_settings", true);`,
			`user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1, .local");`,
			// Keep WebRTC from revealing the real IP.
			`user_pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);`,
			`user_pref("media.peerconnection.ice.default_address_only", true);`,
		}
	}
	js = strings.TrimRight(js, " \t\r\n\f\v")
	sep := ""
	if strings.TrimSpace(js) != "" {
		sep = "\n\n"
	}
	js = js + sep + beginMark + "\n" + strings.Join(prefs, "\n") + "\n" + endMark + "\n"
	return os.WriteFile(file, []byte(js), 0o644)
}

// ---------- launching ----------

func spawnDetached(name string, args ...string) {
	cmd := exec.Command(name, args...)
	detach(cmd)
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
}

// OpenProfile opens a window in that profile. If the browser is running, it just adds the window.
func OpenProfile(browser, dir, url string) error {
	b := find(browser)
	if b == nil {
		return errors.New("Unknown browser")
	}
	app := findApp(b)
	if app == "" {
		return fmt.Errorf("Couldn't find %s on this computer", b.name)
	}
	args := []string{"--profile-directory=" + dir, url}
	if runtime.GOOS == "darwin" {
		spawnDetached("open", append([]string{"-na", app, "--args"}, args...)...)
	} else {
		spawnDetached(app, args...)
	}
	return nil
}

// RevealFolder shows a folder in Finder / Explorer / the file manager.
func RevealFolder(dir string) {
	switch runtime.GOOS {
	case "darwin":
		spawnDetached("open", dir)
	case "windows":
		spawnDetached("explorer.exe", dir)
	default:
		spawnDetached("xdg-open", dir)
	}
}

// ---------- Chrome-family profile prefs ----------

var prefsServer = regexp.MustCompile(`^(?:https?://)?127\.0\.0\.1:(\d+)$`)

// PrefsProxyPort is the gateway port the profile's proxy pref points at, or nil.
func PrefsProxyPort(profileDir string) *int {
	proxy := obj(readJSON(filepath.Join(profileDir, "Preferences"))["proxy"])
	if proxy["mode"] != "fixed_servers" {
		return nil
	}
	server, ok := proxy["server"].(string)
	if !ok {
		return nil
	}
	m := prefsServer.FindStringSubmatch(server)
	if m == nil {
		return nil
	}
	n, _ := strconv.Atoi(m[1])
	return &n
}

// WriteProfileProxy sets or removes our proxy pref in one profile of the named browser.
func WriteProfileProxy(browser, dir string, port *int) error {
	b := find(browser)
	if b == nil {
		return errors.New("Unknown browser")
	}
	return WriteProfilePrefs(filepath.Join(userDataDir(b), dir), port, b.name)
}

// WriteProfilePrefs sets (port) or removes (nil) our proxy in one profile folder.
// The browser must not be running; every other key is preserved.
func WriteProfilePrefs(profileDir string, port *int, browserName string) error {
	if browserName == "" {
		browserName = "the browser"
	}
	file := filepath.Join(profileDir, "Preferences")
	prefs := readJSON(file)
	if prefs == nil {
		return fmt.Errorf("Couldn't read the %s settings for this profile", browserName)
	}
	webrtc := obj(prefs["webrtc"])
	if webrtc == nil {
		webrtc = map[string]any{}
	}
	if port == nil {
		delete(prefs, "proxy")
		if webrtc["ip_handling_policy"] == "disable_non_proxied_udp" {
			delete(webrtc, "ip_handling_policy")
		}
	} else {
		prefs["proxy"] = map[string]any{"mode": "fixed_servers", "server": fmt.Sprintf("http://127.0.0.1:%d", *port), "bypass_list": "<local>"}
		// Keep WebRTC from revealing the real IP.
		webrtc["ip_handling_policy"] = "disable_non_proxied_udp"
	}
	prefs["webrtc"] = webrtc
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(prefs); err != nil {
		return err
	}
	tmp := file + ".proxy-app.tmp"
	if err := os.WriteFile(tmp, bytes.TrimRight(buf.Bytes(), "\n"), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// BrowserApp returns the browser as an app we can find, quit and relaunch, or nil if not installed.
func BrowserApp(browser string) *apps.Scanned {
	b := find(browser)
	if b == nil {
		return nil
	}
	app := findApp(b)
	if app == "" {
		return nil
	}
	exe := app
	if runtime.GOOS == "darwin" {
		exe = filepath.Join(app, "Contents", "MacOS", b.macExe)
	}
	return &apps.Scanned{ID: b.id, Name: b.name, Path: app, Exe: exe, Engine: "chromium", Method: "launch"}
}
