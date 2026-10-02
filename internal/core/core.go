// Package core owns everything that isn't UI or networking plumbing: saved
// proxies, which exit is active, the local gateway, the OS proxy setting and
// the checks that tell the user which IP they have. The control API (package
// server) drives it.
package core

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/big-forge/big-proxy/internal/gateway"
	"github.com/big-forge/big-proxy/internal/ipcheck"
	"github.com/big-forge/big-proxy/internal/netutil"
	"github.com/big-forge/big-proxy/internal/parse"
	"github.com/big-forge/big-proxy/internal/providers"
	"github.com/big-forge/big-proxy/internal/secure"
	"github.com/big-forge/big-proxy/internal/store"
	"github.com/big-forge/big-proxy/internal/sysproxy"
	"github.com/big-forge/big-proxy/internal/types"
	"github.com/big-forge/big-proxy/internal/upstream"
)

const (
	restoreFile      = "sysproxy-restore.json"
	activityLimit    = 500
	firstPinnedPort  = 8901
	statePublishWait = 30 * time.Millisecond
)

// APIError carries an HTTP status for the control API.
type APIError struct {
	Status int
	Msg    string
}

func (e *APIError) Error() string { return e.Msg }

func apiErr(status int, format string, a ...any) *APIError {
	return &APIError{Status: status, Msg: fmt.Sprintf(format, a...)}
}

// Options configure a Core.
type Options struct {
	DataDir string
	Shell   string // desktop | web
	Version string
	// Extension holds the browser extension files (manifest.json at its root).
	// They are copied into DataDir so browsers load them from a stable path.
	Extension fs.FS
	// IconProvider optionally supplies app icons from the shell (unused by default).
	OnStateChanged func()
}

// Event is what the control API streams to the UI.
type Event struct {
	Kind     string // state | stats | activity
	State    *types.AppState
	Stats    *types.TrafficStats
	Activity []types.ActivityEntry
}

type check struct {
	session string
	done    chan struct{}
	result  types.ExitCheck
}

// Core is safe for concurrent use. All mutable state is guarded by st.Mu, the
// same mutex that guards the persisted data; Save/Flush must be called without it.
type Core struct {
	opts         Options
	st           *store.Store
	gw           *gateway.Gateway
	extensionDir string

	opMu sync.Mutex // serialises connect/disconnect/switch/settings

	// guarded by st.Mu
	status           string
	statusError      string
	sysSnap          *sysproxy.Snapshot
	systemProxyError string
	checks           map[string]*check
	activity         map[int64]types.ActivityEntry
	activityOrder    []int64
	pendingActivity  map[int64]types.ActivityEntry
	lan              []string
	upstreamErr      *types.UpstreamError
	upstreamFailures int
	lastUp, lastDown int64
	sessUp, sessDown int64
	ticks            int
	update           *types.UpdateState
	rotateStop       chan struct{}
	statePending     bool

	subMu sync.Mutex
	subs  map[chan Event]struct{}

	stopStats chan struct{}
}

// New opens the config and prepares a Core. Call Init to start it.
func New(opts Options) (*Core, error) {
	st, err := store.New(opts.DataDir)
	if err != nil {
		return nil, err
	}
	c := &Core{
		opts:            opts,
		st:              st,
		extensionDir:    filepath.Join(opts.DataDir, "browser-extension"),
		status:          "off",
		checks:          map[string]*check{},
		activity:        map[int64]types.ActivityEntry{},
		pendingActivity: map[int64]types.ActivityEntry{},
		subs:            map[chan Event]struct{}{},
		stopStats:       make(chan struct{}),
	}
	c.gw = gateway.New(&hooks{c})
	c.gw.OnActivity(c.onActivity)
	return c, nil
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func nowMs() int64 { return time.Now().UnixMilli() }

func (c *Core) lock()   { c.st.Mu.Lock() }
func (c *Core) unlock() { c.st.Mu.Unlock() }
func (c *Core) data() *store.ConfigFile {
	return c.st.Data
}

// Init starts background work. The gateway listens at once, refusing traffic,
// so the browser extension can find the app and connect it.
func (c *Core) Init() {
	c.recoverSystemProxy()
	c.installExtension()
	c.lock()
	changed := c.assignPorts(c.data().Exits)
	c.lan = netutil.LanAddresses()
	start := c.data().Settings.StartConnected && c.activeExitLocked() != nil
	c.unlock()
	if changed {
		c.st.Save()
	}
	go c.statsLoop()
	c.startGateway()
	if start {
		_, _ = c.Connect()
	}
}

func (c *Core) startGateway() error {
	c.lock()
	cfg := c.gatewayConfigLocked()
	c.unlock()
	return c.gw.Start(cfg)
}

// Shutdown restores system settings and stops listening.
func (c *Core) Shutdown() {
	select {
	case <-c.stopStats:
	default:
		close(c.stopStats)
	}
	_, _ = c.Disconnect()
	c.gw.Stop()
	c.st.Flush()
}

// ---------- events ----------

func (c *Core) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	c.subMu.Lock()
	c.subs[ch] = struct{}{}
	c.subMu.Unlock()
	return ch, func() {
		c.subMu.Lock()
		delete(c.subs, ch)
		c.subMu.Unlock()
	}
}

func (c *Core) publish(e Event) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- e:
		default: // slow reader: it will catch up on the next event
		}
	}
}

// changed publishes the state shortly, coalescing bursts.
func (c *Core) changed() {
	c.lock()
	if c.statePending {
		c.unlock()
		return
	}
	c.statePending = true
	c.unlock()
	time.AfterFunc(statePublishWait, func() {
		c.lock()
		c.statePending = false
		c.unlock()
		st := c.State()
		c.publish(Event{Kind: "state", State: &st})
		if c.opts.OnStateChanged != nil {
			c.opts.OnStateChanged()
		}
	})
}

// ---------- state ----------

// State returns a snapshot that is safe to encode after the call returns.
func (c *Core) State() types.AppState {
	c.lock()
	defer c.unlock()
	d := c.data()
	s := d.Settings
	s.Bypass = append([]string{}, s.Bypass...)
	exits := make([]types.Exit, len(d.Exits))
	copy(exits, d.Exits)
	accounts := make([]types.Account, len(d.Accounts))
	copy(accounts, d.Accounts)
	rules := make(map[string]types.AppRule, len(d.AppRules))
	for k, v := range d.AppRules {
		rules[k] = v
	}
	checking := make([]string, 0, len(c.checks))
	for id := range c.checks {
		checking = append(checking, id)
	}
	sort.Strings(checking)
	var active *string
	if d.ActiveExitID != nil {
		v := *d.ActiveExitID
		active = &v
	}
	var upErr *types.UpstreamError
	if c.upstreamErr != nil {
		v := *c.upstreamErr
		upErr = &v
	}
	var upd *types.UpdateState
	if c.update != nil {
		v := *c.update
		upd = &v
	}
	return types.AppState{
		Version:           c.opts.Version,
		Platform:          nodePlatform(),
		Shell:             c.opts.Shell,
		DataDir:           c.st.Dir,
		Status:            c.status,
		StatusError:       c.statusError,
		SystemProxyActive: c.sysSnap != nil,
		SystemProxyError:  c.systemProxyError,
		ActiveExitID:      active,
		Accounts:          accounts,
		Exits:             exits,
		Settings:          s,
		Checking:          checking,
		LanAddresses:      append([]string{}, c.lan...),
		Usage:             d.Usage,
		UpstreamError:     upErr,
		PinnedErrors:      c.gw.PinnedErrors(),
		ExtensionDir:      c.extensionDir,
		AppRules:          rules,
		Update:            upd,
	}
}

// SetUpdate lets the desktop shell report update progress.
func (c *Core) SetUpdate(u types.UpdateState) {
	c.lock()
	c.update = &u
	c.unlock()
	c.changed()
}

func (c *Core) gatewayStatus() types.GatewayStatus {
	c.lock()
	defer c.unlock()
	d := c.data()
	pinErr := c.gw.PinnedErrors()
	exits := make([]types.GatewayStatusExit, 0, len(d.Exits))
	for _, e := range d.Exits {
		x := types.GatewayStatusExit{ID: e.ID, Name: e.Name, Mode: e.Mode}
		if e.Kind == "proxy" {
			x.Mode = "proxy"
		}
		if e.Port != 0 && pinErr[e.ID] == "" {
			p := e.Port
			x.Port = &p
		}
		if e.LastCheck != nil && e.LastCheck.Info != nil {
			x.IP = e.LastCheck.Info.IP
			x.CountryCode = e.LastCheck.Info.CountryCode
			x.City = e.LastCheck.Info.City
		}
		if x.CountryCode == "" && e.Kind == "provider" {
			x.CountryCode = strings.ToUpper(e.Country)
		}
		if e.LastCheck != nil && e.LastCheck.OK {
			x.LatencyMs = e.LastCheck.LatencyMs
		}
		exits = append(exits, x)
	}
	return types.GatewayStatus{
		App:          "proxy-app",
		Version:      c.opts.Version,
		Connected:    c.status == "on",
		Port:         d.Settings.GatewayPort,
		ActiveExitID: cloneStr(d.ActiveExitID),
		Exits:        exits,
	}
}

func cloneStr(s *string) *string {
	if s == nil {
		return nil
	}
	v := *s
	return &v
}

func (c *Core) Activity() []types.ActivityEntry {
	c.lock()
	defer c.unlock()
	out := make([]types.ActivityEntry, 0, len(c.activityOrder))
	for i := len(c.activityOrder) - 1; i >= 0; i-- {
		out = append(out, c.activity[c.activityOrder[i]])
	}
	return out
}

func (c *Core) ClearActivity() {
	c.lock()
	c.activity = map[int64]types.ActivityEntry{}
	c.activityOrder = nil
	c.pendingActivity = map[int64]types.ActivityEntry{}
	c.unlock()
}

func (c *Core) onActivity(e types.ActivityEntry) {
	c.lock()
	if _, seen := c.activity[e.ID]; !seen {
		c.activityOrder = append(c.activityOrder, e.ID)
		if len(c.activityOrder) > activityLimit {
			delete(c.activity, c.activityOrder[0])
			c.activityOrder = c.activityOrder[1:]
		}
	}
	c.activity[e.ID] = e
	c.pendingActivity[e.ID] = e
	c.unlock()
}

func (c *Core) statsLoop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-c.stopStats:
			return
		case <-t.C:
			c.tick()
		}
	}
}

func (c *Core) tick() {
	up, down, active := c.gw.Totals()
	c.lock()
	dUp, dDown := up-c.lastUp, down-c.lastDown
	if dUp < 0 {
		dUp = 0
	}
	if dDown < 0 {
		dDown = 0
	}
	c.lastUp, c.lastDown = up, down
	if c.status == "on" {
		c.sessUp += dUp
		c.sessDown += dDown
		c.data().Usage.Up += dUp
		c.data().Usage.Down += dDown
	}
	stats := types.TrafficStats{At: nowMs(), UpRate: dUp, DownRate: dDown, Up: c.sessUp, Down: c.sessDown, Active: active}
	var batch []types.ActivityEntry
	if len(c.pendingActivity) > 0 {
		for _, id := range c.activityOrder {
			if e, ok := c.pendingActivity[id]; ok {
				batch = append(batch, e)
			}
		}
		c.pendingActivity = map[int64]types.ActivityEntry{}
	}
	c.ticks++
	ticks, status := c.ticks, c.status
	var recheck string
	if ticks%600 == 0 && status == "on" && c.data().ActiveExitID != nil {
		recheck = *c.data().ActiveExitID // sticky IPs can change when the provider's session ends
	}
	running := c.gw.Running()
	lanNow := netutil.LanAddresses()
	lanChanged := ticks%15 == 0 && strings.Join(lanNow, ",") != strings.Join(c.lan, ",")
	if lanChanged {
		c.lan = lanNow
	}
	c.unlock()

	c.publish(Event{Kind: "stats", Stats: &stats})
	if len(batch) > 0 {
		c.publish(Event{Kind: "activity", Activity: batch})
	}
	if recheck != "" {
		go func() { _, _ = c.CheckExit(recheck, false) }()
	}
	if ticks%15 == 0 {
		if !running && status == "off" {
			_ = c.startGateway() // standby listener couldn't open earlier: keep trying
		}
		if dUp > 0 || dDown > 0 || status == "on" {
			c.st.Save()
		}
		if lanChanged {
			c.changed()
		}
	}
}

// ---------- connection ----------

func (c *Core) activeExitLocked() *types.Exit {
	d := c.data()
	if d.ActiveExitID == nil {
		return nil
	}
	return c.exitLocked(*d.ActiveExitID)
}

func (c *Core) exitLocked(id string) *types.Exit {
	d := c.data()
	for i := range d.Exits {
		if d.Exits[i].ID == id {
			return &d.Exits[i]
		}
	}
	return nil
}

func (c *Core) gatewayConfigLocked() gateway.Config {
	s := c.data().Settings
	var auth *gateway.LanAuth
	if s.AllowLan && s.LanAuth.Enabled && s.LanAuth.Password != "" {
		auth = &gateway.LanAuth{Username: s.LanAuth.Username, Password: s.LanAuth.Password}
	}
	return gateway.Config{Port: s.GatewayPort, AllowLAN: s.AllowLan, LanAuth: auth, Pinned: c.pinnedPortsLocked()}
}

func (c *Core) pinnedPortsLocked() []gateway.PinnedPort {
	var out []gateway.PinnedPort
	for _, e := range c.data().Exits {
		if e.Port != 0 {
			out = append(out, gateway.PinnedPort{ExitID: e.ID, Port: e.Port})
		}
	}
	return out
}

// assignPorts gives every exit without one its own fixed port. Caller holds the lock.
func (c *Core) assignPorts(exits []types.Exit) bool {
	d := c.data()
	taken := map[int]bool{d.Settings.GatewayPort: true}
	for _, e := range d.Exits {
		if e.Port != 0 {
			taken[e.Port] = true
		}
	}
	next := firstPinnedPort
	changed := false
	for i := range exits {
		if exits[i].Port != 0 {
			continue
		}
		for taken[next] {
			next++
		}
		exits[i].Port = next
		taken[next] = true
		changed = true
	}
	return changed
}

func (c *Core) syncPinned() {
	if c.gw.Running() {
		c.lock()
		pins := c.pinnedPortsLocked()
		c.unlock()
		c.gw.SyncPinned(pins)
	}
	c.changed()
}

// dropExits closes live connections that use these exits so their apps reconnect with the new IP.
func (c *Core) dropExits(ids ...string) {
	c.lock()
	on := c.status == "on" && c.data().Settings.DropOnSwitch
	c.unlock()
	if !on {
		return
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	c.gw.Drop(func(ci gateway.ConnInfo) bool { return ci.ExitID != "" && set[ci.ExitID] })
}

func (c *Core) Connect() (types.AppState, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.lock()
	if c.status == "on" {
		c.unlock()
		return c.State(), nil
	}
	if c.activeExitLocked() == nil {
		c.unlock()
		return types.AppState{}, apiErr(400, "Add a proxy first, then pick which IP to use.")
	}
	c.status, c.statusError = "connecting", ""
	c.unlock()
	c.changed()

	if !c.gw.Running() {
		if err := c.startGateway(); err != nil {
			c.lock()
			c.status, c.statusError = "error", err.Error()
			c.unlock()
			c.changed()
			return types.AppState{}, apiErr(409, "%s", err.Error())
		}
	}
	c.gw.SetActive(true)
	c.lock()
	c.lastUp, c.lastDown, c.sessUp, c.sessDown = 0, 0, 0, 0
	// totals restart with the listener; keep rates sane
	c.status = "on"
	useSystem := c.data().Settings.SystemProxy
	var active string
	if c.data().ActiveExitID != nil {
		active = *c.data().ActiveExitID
	}
	c.unlock()
	if useSystem {
		c.applySystemProxy()
	}
	c.scheduleRotate()
	c.changed()
	if active != "" {
		go func() { _, _ = c.CheckExit(active, false) }()
	}
	return c.State(), nil
}

func (c *Core) Disconnect() (types.AppState, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.stopRotate()
	c.restoreSystemProxy()
	c.gw.SetActive(false) // stay in standby: traffic refused, the extension can still reach us
	c.lock()
	c.status, c.statusError = "off", ""
	c.unlock()
	c.st.Save()
	c.changed()
	return c.State(), nil
}

func (c *Core) applySystemProxy() {
	c.lock()
	if c.sysSnap != nil {
		c.unlock()
		return
	}
	port := c.data().Settings.GatewayPort
	bypass := append([]string{}, c.data().Settings.Bypass...)
	c.unlock()
	drv := sysproxy.ForPlatform()
	if drv == nil {
		c.lock()
		c.systemProxyError = "Automatic setup isn't available on this system. Point your apps at the gateway address instead."
		c.unlock()
		return
	}
	snap, err := drv.Apply("127.0.0.1", port, bypass)
	c.lock()
	if err != nil {
		c.systemProxyError = err.Error()
		c.unlock()
		return
	}
	c.sysSnap = &snap
	c.systemProxyError = ""
	c.unlock()
	_ = c.st.WriteJSON(restoreFile, snap)
}

func (c *Core) restoreSystemProxy() {
	c.lock()
	snap := c.sysSnap
	c.sysSnap = nil
	c.unlock()
	if snap == nil {
		return
	}
	if drv := sysproxy.ForPlatform(); drv != nil {
		if err := drv.Restore(*snap); err != nil {
			c.lock()
			c.systemProxyError = "Couldn't restore your previous proxy settings: " + err.Error()
			c.unlock()
			return
		}
	}
	c.st.Remove(restoreFile)
}

// recoverSystemProxy: if the app died while connected, the OS still points at a dead gateway.
func (c *Core) recoverSystemProxy() {
	var snap sysproxy.Snapshot
	if !c.st.ReadJSON(restoreFile, &snap) {
		return
	}
	if snap.Platform == nodePlatform() {
		if drv := sysproxy.ForPlatform(); drv != nil {
			_ = drv.Restore(snap)
		}
	}
	c.st.Remove(restoreFile)
}

func (c *Core) onUpstreamResult(err *upstream.Error) {
	c.lock()
	if err == nil {
		c.upstreamFailures = 0
		had := c.upstreamErr != nil
		c.upstreamErr = nil
		c.unlock()
		if had {
			c.changed()
		}
		return
	}
	notify := false
	if err.Code == "auth" || err.Code == "refused" || err.Code == "unreachable" {
		c.upstreamFailures++
		if err.Code == "auth" || c.upstreamFailures >= 3 {
			c.upstreamErr = &types.UpstreamError{At: nowMs(), Message: err.Msg}
			notify = true
		}
	}
	c.unlock()
	if notify {
		c.changed()
	}
}

func (c *Core) stopRotate() {
	c.lock()
	if c.rotateStop != nil {
		close(c.rotateStop)
		c.rotateStop = nil
	}
	c.unlock()
}

func (c *Core) scheduleRotate() {
	c.stopRotate()
	c.lock()
	minutes := c.data().Settings.AutoRotateMinutes
	if c.status != "on" || minutes <= 0 {
		c.unlock()
		return
	}
	stop := make(chan struct{})
	c.rotateStop = stop
	c.unlock()
	go func() {
		t := time.NewTicker(time.Duration(minutes) * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				c.lock()
				e := c.activeExitLocked()
				var id string
				if e != nil && e.Kind == "provider" && e.Mode == "sticky" {
					id = e.ID
				}
				c.unlock()
				if id != "" {
					_, _ = c.RotateExit(id)
				}
			}
		}
	}()
}

// ---------- exits ----------

// ActivateExit moves new connections to another exit; the main port's open connections are closed when dropOnSwitch is on.
func (c *Core) ActivateExit(id string) (types.AppState, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.lock()
	if c.exitLocked(id) == nil {
		c.unlock()
		return types.AppState{}, errExitGone()
	}
	d := c.data()
	if d.ActiveExitID == nil || *d.ActiveExitID != id {
		v := id
		d.ActiveExitID = &v
		c.upstreamErr, c.upstreamFailures = nil, 0
		drop := c.status == "on" && d.Settings.DropOnSwitch
		c.unlock()
		if drop {
			c.gw.Drop(func(ci gateway.ConnInfo) bool { return ci.Pinned == "" }) // pinned ports keep their own IP
		}
		c.st.Save()
		c.changed()
	} else {
		c.unlock()
	}
	go func() { _, _ = c.CheckExit(id, false) }()
	return c.State(), nil
}

func errExitGone() error { return apiErr(404, "That IP is no longer in your list") }

// RotateExit is "New IP": a fresh session id makes the provider hand out a different IP.
func (c *Core) RotateExit(id string) (types.ExitCheck, error) {
	c.lock()
	e := c.exitLocked(id)
	if e == nil {
		c.unlock()
		return types.ExitCheck{}, errExitGone()
	}
	if e.Kind != "provider" || e.Mode != "sticky" {
		msg := "This exit already changes IP on every connection."
		if e.Kind == "proxy" {
			msg = "This proxy has a fixed IP."
		}
		c.unlock()
		return types.ExitCheck{}, apiErr(400, "%s", msg)
	}
	e.Session = secure.SessionID()
	e.SessionStartedAt = nowMs()
	e.LastCheck = nil
	c.unlock()
	c.dropExits(id)
	c.st.Save()
	c.changed()
	return c.CheckExit(id, true)
}

// CheckExit looks up the exit's public IP. With heal, a sticky session whose
// residential peer is dead is swapped for a fresh one (up to 3 tries).
func (c *Core) CheckExit(id string, heal bool) (types.ExitCheck, error) {
	c.lock()
	e := c.exitLocked(id)
	if e == nil {
		c.unlock()
		return types.ExitCheck{}, errExitGone()
	}
	if providers.UpstreamFor(*e, c.data().Accounts) == nil {
		c.unlock()
		return types.ExitCheck{}, apiErr(400, "The account for this IP was removed")
	}
	session := e.Session
	if running := c.checks[id]; running != nil && running.session == session {
		c.unlock()
		<-running.done
		return running.result, nil
	}
	r := &check{session: session, done: make(chan struct{})}
	c.checks[id] = r
	c.unlock()
	c.changed()

	attempts := 1
	if heal {
		attempts = 3
	}
	r.result = c.runCheck(id, attempts, r)
	c.lock()
	if c.checks[id] == r {
		delete(c.checks, id)
	}
	c.unlock()
	close(r.done)
	c.changed()
	return r.result, nil
}

func (c *Core) runCheck(id string, attempts int, r *check) types.ExitCheck {
	for attempt := 1; ; attempt++ {
		c.lock()
		e := c.exitLocked(id)
		var up *types.ProxyEndpoint
		session := ""
		if e != nil {
			up = providers.UpstreamFor(*e, c.data().Accounts)
			session = e.Session
		}
		c.unlock()
		if e == nil || up == nil {
			return types.ExitCheck{At: nowMs(), OK: false, Error: "This IP was removed"}
		}
		result := ipcheck.Check(*up)

		c.lock()
		cur := c.exitLocked(id)
		// Superseded: the session was rotated or the exit deleted while we checked.
		if cur == nil || (cur.Kind == "provider" && cur.Session != session) {
			c.unlock()
			return result
		}
		deadPeer := !result.OK && (result.ErrorCode == "target" || result.ErrorCode == "timeout" || result.ErrorCode == "protocol")
		if deadPeer && attempt < attempts && cur.Kind == "provider" && cur.Mode == "sticky" {
			cur.Session = secure.SessionID()
			cur.SessionStartedAt = nowMs()
			r.session = cur.Session // same in-flight check, now tracking the new session
			c.unlock()
			continue
		}
		res := result
		cur.LastCheck = &res
		isActive := c.data().ActiveExitID != nil && *c.data().ActiveExitID == id
		c.unlock()
		c.st.Save()
		if isActive {
			if result.OK {
				c.onUpstreamResult(nil)
			} else if result.ErrorCode == "auth" {
				c.lock()
				c.upstreamErr = &types.UpstreamError{At: nowMs(), Message: result.Error}
				c.unlock()
			}
		}
		return result
	}
}

// CheckMany checks exits with up to 4 at a time.
func (c *Core) CheckMany(ids []string, heal bool) {
	queue := make(chan string, len(ids))
	for _, id := range ids {
		queue <- id
	}
	close(queue)
	var wg sync.WaitGroup
	n := 4
	if len(ids) < n {
		n = len(ids)
	}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range queue {
				_, _ = c.CheckExit(id, heal)
			}
		}()
	}
	wg.Wait()
}

func validMode(m string) string {
	if m == "rotating" {
		return "rotating"
	}
	return "sticky"
}

func countryName(code string) string {
	if code == "" {
		return "Any country"
	}
	if n, ok := countryNames[strings.ToLower(code)]; ok {
		return n
	}
	return strings.ToUpper(code)
}

func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		r := []rune(w)
		r[0] = []rune(strings.ToUpper(string(r[0])))[0]
		words[i] = string(r)
	}
	return strings.Join(words, " ")
}

func (c *Core) makeProviderExits(in types.CreateExitsInput, taken map[string]bool) []types.Exit {
	count := in.Count
	if count < 1 {
		count = 1
	}
	if count > 25 {
		count = 25
	}
	country := strings.ToLower(in.Country)
	city := strings.TrimSpace(in.City)
	place := countryName(country)
	if city != "" {
		place = titleCase(city)
	}
	mode := validMode(in.Mode)
	var out []types.Exit
	n := 1
	for i := 0; i < count; i++ {
		var name string
		if mode == "rotating" {
			name = place + " rotating"
			for k := 2; taken[name]; k++ {
				name = fmt.Sprintf("%s rotating %d", place, k)
			}
		} else {
			for taken[fmt.Sprintf("%s %d", place, n)] {
				n++
			}
			name = fmt.Sprintf("%s %d", place, n)
		}
		taken[name] = true
		e := types.Exit{
			Kind: "provider", ID: secure.NewID("exit"), Name: name, AccountID: in.AccountID, Mode: mode,
			Country: country, City: city, Session: secure.SessionID(), SessionStartedAt: nowMs(), CreatedAt: nowMs(),
		}
		if mode == "sticky" {
			e.SessionMinutes = in.SessionMinutes
		}
		out = append(out, e)
	}
	return out
}

func (c *Core) takenNamesLocked() map[string]bool {
	m := map[string]bool{}
	for _, e := range c.data().Exits {
		m[e.Name] = true
	}
	return m
}

func (c *Core) addExits(created []types.Exit) {
	c.lock()
	c.assignPorts(created)
	d := c.data()
	d.Exits = append(d.Exits, created...)
	if c.activeExitLocked() == nil && len(created) > 0 {
		v := created[0].ID
		d.ActiveExitID = &v
	}
	c.unlock()
	c.st.Save()
	go c.syncPinned()
	ids := make([]string, len(created))
	for i, e := range created {
		ids[i] = e.ID
	}
	go c.CheckMany(ids, true)
}

type AddProxiesResult struct {
	Created int            `json:"created"`
	Invalid []string       `json:"invalid"`
	State   types.AppState `json:"state"`
}

// AddProxies is the paste box: one proxy per line. Provider logins become an account plus `count` exits.
func (c *Core) AddProxies(in types.AddProxiesInput) (AddProxiesResult, error) {
	parsed, invalid := parse.ParseProxyList(in.Text)
	if len(parsed) == 0 {
		if len(invalid) > 0 {
			return AddProxiesResult{}, apiErr(400, "Couldn't read \"%s\". Use login:password@host:port.", truncate(invalid[0], 40))
		}
		return AddProxiesResult{}, apiErr(400, "Paste at least one proxy.")
	}
	c.lock()
	taken := c.takenNamesLocked()
	var created []types.Exit
	d := c.data()
	for _, p := range parsed {
		if p.Provider != "" {
			var acc *types.Account
			for i := range d.Accounts {
				a := &d.Accounts[i]
				if a.Provider == p.Provider && a.Host == p.Host && a.Port == p.Port && a.Username == p.Username && a.Protocol == p.Protocol {
					acc = a
				}
			}
			if acc == nil {
				d.Accounts = append(d.Accounts, types.Account{
					ID: secure.NewID("acc"), Provider: p.Provider, Name: providers.Name(p.Provider), Protocol: p.Protocol,
					Host: p.Host, Port: p.Port, Username: p.Username, Password: p.Password, CreatedAt: nowMs(),
				})
				acc = &d.Accounts[len(d.Accounts)-1]
			} else if p.Password != "" {
				acc.Password = p.Password
			}
			country, city := p.Country, p.City
			if in.Country != nil {
				country = *in.Country
			}
			if in.City != nil {
				city = *in.City
			}
			count := 3
			if in.Count != nil {
				count = *in.Count
			}
			created = append(created, c.makeProviderExits(types.CreateExitsInput{
				AccountID: acc.ID, Mode: in.Mode, Country: country, City: city, SessionMinutes: in.SessionMinutes, Count: count,
			}, taken)...)
		} else {
			created = append(created, types.Exit{
				Kind: "proxy", ID: secure.NewID("exit"), Name: fmt.Sprintf("%s:%d", p.Host, p.Port), CreatedAt: nowMs(),
				Proxy: &types.ProxyEndpoint{Protocol: p.Protocol, Host: p.Host, Port: p.Port, Username: p.Username, Password: p.Password},
			})
		}
	}
	c.unlock()
	c.addExits(created)
	if invalid == nil {
		invalid = []string{}
	}
	return AddProxiesResult{Created: len(created), Invalid: invalid, State: c.State()}, nil
}

type CreateExitsResult struct {
	Created int            `json:"created"`
	State   types.AppState `json:"state"`
}

func (c *Core) CreateExits(in types.CreateExitsInput) (CreateExitsResult, error) {
	c.lock()
	found := false
	for _, a := range c.data().Accounts {
		if a.ID == in.AccountID {
			found = true
		}
	}
	if !found {
		c.unlock()
		return CreateExitsResult{}, apiErr(404, "That account no longer exists")
	}
	exits := c.makeProviderExits(in, c.takenNamesLocked())
	c.unlock()
	c.addExits(exits)
	return CreateExitsResult{Created: len(exits), State: c.State()}, nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// UpdateExit applies a partial edit; patch comes straight from the JSON body.
func (c *Core) UpdateExit(id string, patch map[string]any) (types.AppState, error) {
	c.lock()
	e := c.exitLocked(id)
	if e == nil {
		c.unlock()
		return types.AppState{}, errExitGone()
	}
	d := c.data()
	if v, ok := patch["name"].(string); ok && strings.TrimSpace(v) != "" {
		e.Name = truncate(strings.TrimSpace(v), 60)
	}
	pinChanged := false
	if v, ok := num(patch["port"]); ok && v != e.Port {
		if v < 1024 || v > 65535 {
			c.unlock()
			return types.AppState{}, apiErr(400, "Use a port between 1024 and 65535")
		}
		clash := v == d.Settings.GatewayPort
		for _, o := range d.Exits {
			if o.ID != id && o.Port == v {
				clash = true
			}
		}
		if clash {
			c.unlock()
			return types.AppState{}, apiErr(400, "Port %d is already used by Proxy App", v)
		}
		e.Port = v
		pinChanged = true
	}
	routeChanged := false
	if e.Kind == "provider" {
		if m, ok := patch["mode"].(string); ok && m != "" && m != e.Mode {
			e.Mode = validMode(m)
			routeChanged = true
		}
		if v, ok := patch["country"].(string); ok && strings.ToLower(v) != e.Country {
			e.Country = strings.ToLower(v)
			routeChanged = true
		}
		if v, ok := patch["city"].(string); ok && strings.TrimSpace(v) != e.City {
			e.City = strings.TrimSpace(v)
			routeChanged = true
		}
		if raw, present := patch["sessionMinutes"]; present {
			v, _ := num(raw) // null or 0 = provider default
			if v != e.SessionMinutes {
				e.SessionMinutes = v
				routeChanged = true
			}
		}
		if routeChanged {
			e.Session = secure.SessionID()
			e.SessionStartedAt = nowMs()
		}
	} else if px, ok := patch["proxy"].(map[string]any); ok && e.Proxy != nil {
		next := *e.Proxy
		if v, ok := px["protocol"].(string); ok {
			next.Protocol = v
		}
		if v, ok := px["host"].(string); ok {
			next.Host = v
		}
		if v, ok := num(px["port"]); ok {
			next.Port = v
		}
		if v, ok := px["username"].(string); ok {
			next.Username = v
		}
		if v, ok := px["password"].(string); ok {
			next.Password = v
		}
		if !validProtocol(next.Protocol) || next.Host == "" || next.Port < 1 || next.Port > 65535 {
			c.unlock()
			return types.AppState{}, apiErr(400, "Enter a valid host and port")
		}
		e.Proxy = &next
		routeChanged = true
	}
	if routeChanged {
		e.LastCheck = nil
	}
	c.unlock()
	if pinChanged {
		go c.syncPinned()
	}
	if routeChanged {
		c.dropExits(id)
		go func() { _, _ = c.CheckExit(id, false) }()
	}
	c.st.Save()
	c.changed()
	return c.State(), nil
}

func validProtocol(p string) bool { return p == "http" || p == "https" || p == "socks5" }

// num reads a JSON number (float64) or int.
func num(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}

func (c *Core) DeleteExit(id string) (types.AppState, error) {
	c.lock()
	d := c.data()
	idx := -1
	for i, e := range d.Exits {
		if e.ID == id {
			idx = i
		}
	}
	if idx < 0 {
		c.unlock()
		return types.AppState{}, errExitGone()
	}
	d.Exits = append(d.Exits[:idx:idx], d.Exits[idx+1:]...)
	c.unlock()
	c.afterExitRemoval()
	return c.State(), nil
}

func (c *Core) ReorderExits(ids []string) types.AppState {
	order := map[string]int{}
	for i, id := range ids {
		order[id] = i
	}
	c.lock()
	d := c.data()
	sort.SliceStable(d.Exits, func(i, j int) bool {
		oi, ok := order[d.Exits[i].ID]
		if !ok {
			oi = 1 << 30
		}
		oj, ok := order[d.Exits[j].ID]
		if !ok {
			oj = 1 << 30
		}
		return oi < oj
	})
	c.unlock()
	c.st.Save()
	c.changed()
	return c.State()
}

func (c *Core) afterExitRemoval() {
	c.lock()
	d := c.data()
	// Apps pinned to a removed IP fall back to following the app.
	for k, rule := range d.AppRules {
		if rule.ExitID != nil && c.exitLocked(*rule.ExitID) == nil {
			rule.ExitID = nil
			d.AppRules[k] = rule
		}
	}
	dropMain := false
	if c.activeExitLocked() == nil {
		d.ActiveExitID = nil
		if len(d.Exits) > 0 {
			v := d.Exits[0].ID
			d.ActiveExitID = &v
		}
		dropMain = c.status == "on" && d.Settings.DropOnSwitch
	}
	noExit := d.ActiveExitID == nil && c.status == "on"
	c.unlock()
	if dropMain {
		c.gw.Drop(func(ci gateway.ConnInfo) bool { return ci.Pinned == "" })
	}
	c.st.Save()
	c.syncPinned()
	if noExit {
		_, _ = c.Disconnect()
	}
}

// ---------- accounts ----------

func (c *Core) UpdateAccount(id string, patch map[string]any) (types.AppState, error) {
	c.lock()
	d := c.data()
	var a *types.Account
	for i := range d.Accounts {
		if d.Accounts[i].ID == id {
			a = &d.Accounts[i]
		}
	}
	if a == nil {
		c.unlock()
		return types.AppState{}, apiErr(404, "That account no longer exists")
	}
	if v, ok := patch["name"].(string); ok && strings.TrimSpace(v) != "" {
		a.Name = truncate(strings.TrimSpace(v), 60)
	}
	creds := false
	if v, ok := patch["username"].(string); ok && strings.TrimSpace(v) != "" && strings.TrimSpace(v) != a.Username {
		base, _, _ := providers.ParseLogin(a.Provider, strings.TrimSpace(v)) // a pasted login with parameters keeps only its base
		a.Username = base
		creds = true
	}
	if v, ok := patch["password"].(string); ok && v != "" && v != a.Password {
		a.Password = v
		creds = true
	}
	if v, ok := patch["host"].(string); ok && strings.TrimSpace(v) != "" && strings.TrimSpace(v) != a.Host {
		a.Host = strings.TrimSpace(v)
		creds = true
	}
	if v, ok := num(patch["port"]); ok && v != a.Port {
		if v < 1 || v > 65535 {
			c.unlock()
			return types.AppState{}, apiErr(400, "Port must be between 1 and 65535")
		}
		a.Port = v
		creds = true
	}
	if v, ok := patch["protocol"].(string); ok && v != "" && v != a.Protocol {
		if !validProtocol(v) {
			c.unlock()
			return types.AppState{}, apiErr(400, "Unknown protocol")
		}
		a.Protocol = v
		creds = true
	}
	var ids []string
	if creds {
		c.upstreamErr, c.upstreamFailures = nil, 0
		for _, e := range d.Exits {
			if e.Kind == "provider" && e.AccountID == id {
				ids = append(ids, e.ID)
			}
		}
	}
	c.unlock()
	if creds {
		c.dropExits(ids...)
		go c.CheckMany(ids, false)
	}
	c.st.Save()
	c.changed()
	return c.State(), nil
}

func (c *Core) DeleteAccount(id string) (types.AppState, error) {
	c.lock()
	d := c.data()
	found := false
	accs := d.Accounts[:0:0]
	for _, a := range d.Accounts {
		if a.ID == id {
			found = true
			continue
		}
		accs = append(accs, a)
	}
	if !found {
		c.unlock()
		return types.AppState{}, apiErr(404, "That account no longer exists")
	}
	d.Accounts = accs
	exits := d.Exits[:0:0]
	for _, e := range d.Exits {
		if e.Kind == "provider" && e.AccountID == id {
			continue
		}
		exits = append(exits, e)
	}
	d.Exits = exits
	c.unlock()
	c.afterExitRemoval()
	return c.State(), nil
}

// TestProxy tries the first proxy line without saving it.
func (c *Core) TestProxy(in types.TestProxyInput) types.TestProxyResult {
	line := ""
	for _, l := range strings.Split(in.Text, "\n") {
		if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
			line = l
			break
		}
	}
	p := parse.ParseProxyLine(line)
	if p == nil {
		return types.TestProxyResult{Check: types.ExitCheck{At: nowMs(), OK: false, Error: "That doesn't look like a proxy. Use login:password@host:port."}}
	}
	user := p.Username
	if p.Provider != "" {
		o := providers.LoginOptions{Country: p.Country, City: p.City}
		if in.Country != nil {
			o.Country = *in.Country
		}
		if in.City != nil {
			o.City = *in.City
		}
		if validMode(in.Mode) == "sticky" {
			o.Session = secure.SessionID()
		}
		user = providers.BuildLogin(p.Provider, p.Username, o)
	}
	res := ipcheck.Check(types.ProxyEndpoint{Protocol: p.Protocol, Host: p.Host, Port: p.Port, Username: user, Password: p.Password})
	shown := *p
	if shown.Password != "" {
		shown.Password = "••••"
	}
	return types.TestProxyResult{Parsed: &shown, Check: res}
}

// ---------- settings ----------

func (c *Core) UpdateSettings(patch map[string]any) (types.AppState, error) {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.lock()
	d := c.data()
	prev := d.Settings
	prev.Bypass = append([]string{}, prev.Bypass...)
	next := prev
	next.Bypass = append([]string{}, prev.Bypass...)

	fail := func(status int, format string, a ...any) (types.AppState, error) {
		c.unlock()
		return types.AppState{}, apiErr(status, format, a...)
	}
	if raw, ok := patch["gatewayPort"]; ok {
		port, isNum := num(raw)
		if !isNum || port < 1024 || port > 65535 {
			return fail(400, "Use a port between 1024 and 65535")
		}
		for _, e := range d.Exits {
			if e.Port == port {
				return fail(400, "Port %d is already a fixed port for one of your IPs", port)
			}
		}
		next.GatewayPort = port
	}
	if v, ok := patch["allowLan"].(bool); ok {
		next.AllowLan = v
	}
	if la, ok := patch["lanAuth"].(map[string]any); ok {
		if v, ok := la["enabled"].(bool); ok {
			next.LanAuth.Enabled = v
		}
		if v, ok := la["username"].(string); ok {
			next.LanAuth.Username = v
		}
		if v, ok := la["password"].(string); ok {
			next.LanAuth.Password = v
		}
		if strings.TrimSpace(next.LanAuth.Username) == "" {
			next.LanAuth.Username = "proxy"
		}
		next.LanAuth.Username = strings.TrimSpace(next.LanAuth.Username)
		if next.LanAuth.Enabled && next.LanAuth.Password == "" {
			return fail(400, "Set a password to require a login")
		}
	}
	if v, ok := patch["systemProxy"].(bool); ok {
		next.SystemProxy = v
	}
	if v, ok := patch["dropOnSwitch"].(bool); ok {
		next.DropOnSwitch = v
	}
	if raw, ok := patch["autoRotateMinutes"]; ok {
		m, isNum := num(raw)
		if !isNum || m < 0 || m > 1440 {
			return fail(400, "Pick between 0 and 1440 minutes")
		}
		next.AutoRotateMinutes = m
	}
	if list, ok := patch["bypass"].([]any); ok {
		next.Bypass = nil
		for _, it := range list {
			if s, ok := it.(string); ok && strings.TrimSpace(s) != "" && len(next.Bypass) < 200 {
				next.Bypass = append(next.Bypass, strings.TrimSpace(s))
			}
		}
		if next.Bypass == nil {
			next.Bypass = []string{}
		}
	}
	if v, ok := patch["startConnected"].(bool); ok {
		next.StartConnected = v
	}
	if v, ok := patch["launchAtLogin"].(bool); ok {
		next.LaunchAtLogin = v
	}
	if v, ok := patch["theme"].(string); ok && (v == "system" || v == "light" || v == "dark") {
		next.Theme = v
	}
	d.Settings = next
	status := c.status
	c.unlock()
	c.st.Save()

	gatewayChanged := next.GatewayPort != prev.GatewayPort || next.AllowLan != prev.AllowLan || next.LanAuth != prev.LanAuth
	if gatewayChanged && status != "on" {
		_ = c.startGateway()
	}
	if status == "on" {
		sysChanged := next.SystemProxy != prev.SystemProxy || next.GatewayPort != prev.GatewayPort || strings.Join(next.Bypass, "\n") != strings.Join(prev.Bypass, "\n")
		if sysChanged {
			c.restoreSystemProxy()
		}
		if gatewayChanged {
			if err := c.startGateway(); err != nil {
				c.lock()
				c.status, c.statusError = "error", err.Error()
				c.unlock()
			} else {
				c.gw.SetActive(true)
			}
		}
		c.lock()
		stillOn := c.status == "on"
		c.unlock()
		if sysChanged && next.SystemProxy && stillOn {
			c.applySystemProxy()
		}
		if next.AutoRotateMinutes != prev.AutoRotateMinutes {
			c.scheduleRotate()
		}
	}
	c.changed()
	return c.State(), nil
}

func (c *Core) ResetUsage() types.AppState {
	c.lock()
	c.data().Usage = types.Usage{Since: nowMs()}
	c.unlock()
	c.st.Save()
	c.changed()
	return c.State()
}

// ---------- browser extension files ----------

func (c *Core) installExtension() {
	if c.opts.Extension == nil {
		return
	}
	if _, err := fs.Stat(c.opts.Extension, "manifest.json"); err != nil {
		return
	}
	err := fs.WalkDir(c.opts.Extension, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		dest := filepath.Join(c.extensionDir, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		b, err := fs.ReadFile(c.opts.Extension, p)
		if err != nil {
			return err
		}
		if p == "manifest.json" {
			b = stampVersion(b, c.opts.Version)
		}
		return os.WriteFile(dest, b, 0o644)
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "Couldn't install the browser extension files:", err)
	}
}

// ---------- gateway hooks ----------

type hooks struct{ c *Core }

func (h *hooks) Route(exitID string) *gateway.Route {
	c := h.c
	c.lock()
	defer c.unlock()
	var e *types.Exit
	if exitID != "" {
		e = c.exitLocked(exitID)
	} else {
		e = c.activeExitLocked()
	}
	if e == nil {
		return nil
	}
	up := providers.UpstreamFor(*e, c.data().Accounts)
	if up == nil {
		return nil
	}
	return &gateway.Route{Upstream: *up, ExitID: e.ID}
}

func (h *hooks) PAC(address string) string { return pacScript(address) }

func (h *hooks) UpstreamResult(err *upstream.Error) { h.c.onUpstreamResult(err) }

func (h *hooks) Status() types.GatewayStatus { return h.c.gatewayStatus() }

// Control is what the browser extension may ask for through the gateway.
func (h *hooks) Control(action string, body map[string]any) (any, error) {
	exitID, _ := body["exitId"].(string)
	switch action {
	case "connect":
		if _, err := h.c.Connect(); err != nil {
			return nil, toStatusErr(err)
		}
		return h.c.gatewayStatus(), nil
	case "rotate":
		if exitID == "" {
			return nil, &gateway.StatusError{Status: 400, Msg: "Which IP?"}
		}
		r, err := h.c.RotateExit(exitID)
		if err != nil {
			return nil, toStatusErr(err)
		}
		return r, nil
	case "check":
		if exitID == "" {
			return nil, &gateway.StatusError{Status: 400, Msg: "Which IP?"}
		}
		r, err := h.c.CheckExit(exitID, false)
		if err != nil {
			return nil, toStatusErr(err)
		}
		return r, nil
	}
	return nil, &gateway.StatusError{Status: 404, Msg: "Unknown action"}
}

func toStatusErr(err error) error {
	if ae, ok := err.(*APIError); ok {
		return &gateway.StatusError{Status: ae.Status, Msg: ae.Msg}
	}
	return err
}

// pacScript is for phones: Settings → Wi-Fi → Proxy → Automatic, with this URL.
func pacScript(address string) string {
	return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" || dnsDomainIs(host, ".local")) return "DIRECT";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && (
    isInNet(host, "10.0.0.0", "255.0.0.0") ||
    isInNet(host, "172.16.0.0", "255.240.0.0") ||
    isInNet(host, "192.168.0.0", "255.255.0.0") ||
    isInNet(host, "127.0.0.0", "255.0.0.0") ||
    isInNet(host, "169.254.0.0", "255.255.0.0"))) return "DIRECT";
  return "PROXY ` + address + `";
}
`
}

// stampVersion gives the extension the app's version, so the two stay in step.
// Chrome only accepts dotted numbers, so a "dev" build keeps the manifest's own.
func stampVersion(manifest []byte, version string) []byte {
	if !regexp.MustCompile(`^\d+(\.\d+){0,3}$`).MatchString(version) {
		return manifest
	}
	var m map[string]any
	if json.Unmarshal(manifest, &m) != nil {
		return manifest
	}
	m["version"] = version
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return manifest
	}
	return out
}

// ExitURL is the exit written as a proxy address with its login, for copying into other tools.
func (c *Core) ExitURL(id string) (string, error) {
	c.lock()
	defer c.unlock()
	e := c.exitLocked(id)
	if e == nil {
		return "", errExitGone()
	}
	up := providers.UpstreamFor(*e, c.data().Accounts)
	if up == nil {
		return "", apiErr(400, "The account for this IP was removed")
	}
	auth := ""
	if up.Username != "" || up.Password != "" {
		auth = up.Username + ":" + up.Password + "@"
	}
	scheme := ""
	if up.Protocol != "http" {
		scheme = up.Protocol + "://"
	}
	return fmt.Sprintf("%s%s%s:%d", scheme, auth, up.Host, up.Port), nil
}
