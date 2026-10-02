package core

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/big-forge/big-proxy/internal/apps"
	"github.com/big-forge/big-proxy/internal/browsers"
	"github.com/big-forge/big-proxy/internal/types"
)

// ---------- browser profiles ----------

func (c *Core) BrowserProfiles() []types.BrowserProfile {
	return browsers.ListProfiles(c.extensionDir)
}

// BrowserProfilesLive adds whether each browser is open right now.
func (c *Core) BrowserProfilesLive() []types.BrowserProfile {
	procs := apps.ListProcesses()
	open := map[string]bool{}
	profiles := c.BrowserProfiles()
	for i := range profiles {
		b := profiles[i].Browser
		running, seen := open[b]
		if !seen {
			if app := browsers.BrowserApp(b); app != nil {
				running = apps.FindMain(*app, procs) != nil
			}
			open[b] = running
		}
		profiles[i].Running = running
	}
	return profiles
}

func (c *Core) OpenBrowserProfile(browser, dir, url string) error {
	// Only open profiles we found ourselves; never pass arbitrary input to a browser.
	found := false
	for _, p := range c.BrowserProfiles() {
		if p.Browser == browser && p.Dir == dir {
			found = true
		}
	}
	if !found {
		return apiErr(404, "That browser profile was not found")
	}
	if err := browsers.OpenProfile(browser, dir, url); err != nil {
		return apiErr(400, "%s", err.Error())
	}
	return nil
}

func (c *Core) RevealExtension() error {
	if _, err := os.Stat(filepath.Join(c.extensionDir, "manifest.json")); err != nil {
		return apiErr(404, "The extension files are missing. Reinstall Proxy App.")
	}
	browsers.RevealFolder(c.extensionDir)
	return nil
}

// portFor is the gateway port an app or profile should use: an IP's fixed port, or the main one.
func (c *Core) portFor(exitID string) int {
	c.lock()
	defer c.unlock()
	if exitID != "" {
		if e := c.exitLocked(exitID); e != nil && e.Port != 0 {
			return e.Port
		}
	}
	return c.data().Settings.GatewayPort
}

func (c *Core) exitExists(id string) bool {
	c.lock()
	defer c.unlock()
	return c.exitLocked(id) != nil
}

type ProfileProxyResult struct {
	OK        bool `json:"ok"`
	Restarted bool `json:"restarted"`
	NeedsQuit bool `json:"needsQuit"`
}

// SetFirefoxProxy writes or removes Firefox's managed block; Firefox applies it on its next start.
func (c *Core) SetFirefoxProxy(dir string, enabled bool) (map[string]bool, error) {
	var port *int
	if enabled {
		c.lock()
		p := c.data().Settings.GatewayPort
		c.unlock()
		port = &p
	}
	if err := browsers.SetFirefoxProxy(dir, port); err != nil {
		return nil, apiErr(400, "%s", err.Error())
	}
	return map[string]bool{"ok": true}, nil
}

// SetBrowserProfileProxy switches one Chrome/Edge/Brave profile by writing its own proxy
// setting. The browser rewrites that file while running, so a running browser is quit
// first and reopened with its windows.
func (c *Core) SetBrowserProfileProxy(browser, dir string, enabled bool, exitID string) (ProfileProxyResult, error) {
	var profile *types.BrowserProfile
	for _, p := range c.BrowserProfiles() {
		if p.Browser == browser && p.Dir == dir {
			p := p
			profile = &p
		}
	}
	if profile == nil {
		return ProfileProxyResult{}, apiErr(404, "That browser profile was not found")
	}
	if profile.Kind == "prefs" {
		if _, err := c.SetFirefoxProxy(dir, enabled); err != nil {
			return ProfileProxyResult{}, err
		}
		return ProfileProxyResult{OK: true}, nil
	}
	if exitID != "" && !c.exitExists(exitID) {
		return ProfileProxyResult{}, errExitGone()
	}
	var want *int
	if enabled {
		p := c.portFor(exitID)
		want = &p
	}
	if (profile.ProxyPort == nil && want == nil) || (profile.ProxyPort != nil && want != nil && *profile.ProxyPort == *want) {
		return ProfileProxyResult{OK: true}, nil
	}
	app := browsers.BrowserApp(browser)
	if app == nil {
		return ProfileProxyResult{}, apiErr(400, "Couldn't find %s on this computer", profile.BrowserName)
	}
	running := apps.FindMain(*app, apps.ListProcesses()) != nil
	if running && !apps.QuitApp(*app, 20*time.Second) {
		return ProfileProxyResult{OK: false, NeedsQuit: true}, nil
	}
	err := browsers.WriteProfileProxy(browser, dir, want)
	if running { // bring the browser back the way it was, whether or not the write worked
		apps.LaunchApp(*app, []string{"--restore-last-session"})
	}
	if err != nil {
		return ProfileProxyResult{}, apiErr(400, "%s", err.Error())
	}
	return ProfileProxyResult{OK: true, Restarted: running}, nil
}

// ---------- apps ----------

func (c *Core) ListApps(refresh bool) []types.InstalledApp {
	scanned := apps.Scan(refresh)
	procs := apps.ListProcesses()
	c.lock()
	port := c.data().Settings.GatewayPort
	rules := map[string]types.AppRule{}
	for k, v := range c.data().AppRules {
		rules[k] = v
	}
	c.unlock()
	out := make([]types.InstalledApp, 0, len(scanned))
	for _, a := range scanned {
		main := apps.FindMain(a, procs)
		ia := types.InstalledApp{
			ID: a.ID, Name: a.Name, Path: a.Path, Engine: a.Engine, Method: a.Method,
			Hint:      strings.ReplaceAll(a.Hint, "{port}", strconv.Itoa(port)),
			Running:   main != nil,
			ProxyPort: apps.ProxyPortOf(main),
		}
		if r, ok := rules[a.ID]; ok {
			r := r
			ia.Rule = &r
		}
		out = append(out, ia)
	}
	return out
}

func (c *Core) launchable(id string) (apps.Scanned, error) {
	for _, a := range apps.Scan(false) {
		if a.ID == id {
			if a.Method != "launch" {
				return apps.Scanned{}, apiErr(400, "%s needs its proxy set inside the app", a.Name)
			}
			return a, nil
		}
	}
	return apps.Scanned{}, apiErr(404, "That app is no longer installed")
}

type AppProxyResult struct {
	Restarted bool           `json:"restarted"`
	NeedsQuit bool           `json:"needsQuit"`
	State     types.AppState `json:"state"`
}

// SetAppProxy turns the proxy on or off for one app. Chromium-based apps only read the
// proxy at start, so a running app is quit and reopened.
func (c *Core) SetAppProxy(id string, enabled bool, exitID string) (AppProxyResult, error) {
	app, err := c.launchable(id)
	if err != nil {
		return AppProxyResult{}, err
	}
	if exitID != "" && !c.exitExists(exitID) {
		return AppProxyResult{}, errExitGone()
	}
	c.lock()
	if enabled {
		var ex *string
		if exitID != "" {
			v := exitID
			ex = &v
		}
		c.data().AppRules[id] = types.AppRule{ExitID: ex}
	} else {
		delete(c.data().AppRules, id)
	}
	c.unlock()
	c.st.Save()
	c.changed()

	main := apps.FindMain(app, apps.ListProcesses())
	var want *int
	if enabled {
		p := c.portFor(exitID)
		want = &p
	}
	cur := apps.ProxyPortOf(main)
	same := (cur == nil && want == nil) || (cur != nil && want != nil && *cur == *want)
	if main == nil || same {
		return AppProxyResult{State: c.State()}, nil
	}
	if !apps.QuitApp(app, 10*time.Second) {
		return AppProxyResult{NeedsQuit: true, State: c.State()}, nil
	}
	var args []string
	if want != nil {
		args = apps.ProxyArgs(*want)
	}
	apps.LaunchApp(app, args)
	return AppProxyResult{Restarted: true, State: c.State()}, nil
}

// OpenApp opens the app the way its rule says: through the proxy, or normally.
func (c *Core) OpenApp(id string) (AppProxyResult, error) {
	app, err := c.launchable(id)
	if err != nil {
		return AppProxyResult{}, err
	}
	c.lock()
	rule, hasRule := c.data().AppRules[id]
	c.unlock()
	exitID := ""
	if hasRule && rule.ExitID != nil {
		exitID = *rule.ExitID
	}
	if apps.FindMain(app, apps.ListProcesses()) != nil {
		if !hasRule {
			return AppProxyResult{}, apiErr(409, "%s is already open", app.Name)
		}
		return c.SetAppProxy(id, true, exitID)
	}
	var args []string
	if hasRule {
		args = apps.ProxyArgs(c.portFor(exitID))
	}
	apps.LaunchApp(app, args)
	return AppProxyResult{State: c.State()}, nil
}

func (c *Core) AppIcon(id string) ([]byte, error) {
	for _, a := range apps.Scan(false) {
		if a.ID == id {
			return apps.Icon(a, filepath.Join(c.st.Dir, "icon-cache"))
		}
	}
	return nil, apiErr(404, "unknown app")
}

func (c *Core) OpenTerminal(exitID string) map[string]bool {
	apps.OpenProxyTerminal(c.portFor(exitID), c.st.Dir)
	return map[string]bool{"ok": true}
}
