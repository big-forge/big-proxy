// Package gateway is the local proxy every app talks to. One port speaks HTTP
// (plain and CONNECT) and SOCKS5, decided by the first byte. The main port
// routes each new connection through whatever exit is active at that moment;
// pinned ports always use their own exit.
package gateway

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/big-forge/big-proxy/internal/netutil"
	"github.com/big-forge/big-proxy/internal/types"
	"github.com/big-forge/big-proxy/internal/upstream"
)

const (
	idleTimeout = 5 * time.Minute
	maxHead     = 64 * 1024
)

type PinnedPort struct {
	ExitID string
	Port   int
}

type LanAuth struct{ Username, Password string }

type Config struct {
	Port     int
	AllowLAN bool
	LanAuth  *LanAuth
	Pinned   []PinnedPort
}

type Route struct {
	Upstream types.ProxyEndpoint
	ExitID   string
}

// ConnInfo describes an open connection to Drop matchers. "" means none.
type ConnInfo struct {
	Pinned string
	ExitID string
}

type Hooks interface {
	Route(exitID string) *Route
	PAC(address string) string
	UpstreamResult(err *upstream.Error)
	Status() types.GatewayStatus
	Control(action string, body map[string]any) (any, error)
}

// StatusError lets Hooks.Control choose the HTTP status of a failure.
type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }

// gwError is a gateway-originated refusal with its own HTTP status.
type gwError struct {
	status int
	msg    string
}

func (e *gwError) Error() string { return e.msg }

type pinnedListener struct {
	port int
	l    net.Listener
}

type Gateway struct {
	hooks  Hooks
	active atomic.Bool

	mu         sync.Mutex
	server     net.Listener
	pinned     map[string]pinnedListener
	pinErrors  map[string]string
	cfg        *Config
	conns      map[*conn]struct{}
	closedUp   int64
	closedDown int64
	onActivity func(types.ActivityEntry)
	nextID     atomic.Int64
}

func New(h Hooks) *Gateway {
	return &Gateway{hooks: h, pinned: map[string]pinnedListener{}, pinErrors: map[string]string{}, conns: map[*conn]struct{}{}}
}

func (g *Gateway) Running() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.server != nil
}

// Port returns the port the main listener is bound to (0 when stopped).
func (g *Gateway) Port() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cfg == nil {
		return 0
	}
	return g.cfg.Port
}

// SetActive(false) = standby: keep listening, refuse traffic.
func (g *Gateway) SetActive(active bool) {
	g.active.Store(active)
	if !active {
		g.DropAll()
	}
}

func (g *Gateway) PinnedErrors() map[string]string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]string, len(g.pinErrors))
	for k, v := range g.pinErrors {
		out[k] = v
	}
	return out
}

func (g *Gateway) OnActivity(fn func(types.ActivityEntry)) {
	g.mu.Lock()
	g.onActivity = fn
	g.mu.Unlock()
}

// Windows reports these with its own error codes and wording, so match the text as well.
func portMessage(err error, port int, fix string) string {
	text := strings.ToLower(err.Error())
	if errors.Is(err, syscall.EADDRINUSE) || strings.Contains(text, "address already in use") || strings.Contains(text, "only one usage of each socket address") {
		return fmt.Sprintf("Port %d is already in use by another app. %s", port, fix)
	}
	if errors.Is(err, syscall.EACCES) || strings.Contains(text, "forbidden by its access permissions") {
		return fmt.Sprintf("This computer won't let Proxy App use port %d. %s", port, fix)
	}
	return err.Error()
}

func (g *Gateway) listen(port int, allowLAN bool, pinned string) (net.Listener, error) {
	host := "127.0.0.1"
	if allowLAN {
		host = "0.0.0.0"
	}
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					continue
				}
				return
			}
			go g.onConnection(c, pinned)
		}
	}()
	return l, nil
}

// Start (re)starts the gateway.
func (g *Gateway) Start(cfg Config) error {
	if g.Running() {
		g.Stop()
	}
	l, err := g.listen(cfg.Port, cfg.AllowLAN, "")
	if err != nil {
		return errors.New(portMessage(err, cfg.Port, "Pick a different port in Settings."))
	}
	if cfg.Port == 0 {
		cfg.Port = l.Addr().(*net.TCPAddr).Port
	}
	g.mu.Lock()
	g.server = l
	g.cfg = &cfg
	g.closedUp, g.closedDown = 0, 0
	g.mu.Unlock()
	g.SyncPinned(cfg.Pinned)
	return nil
}

// SyncPinned opens and closes pinned ports to match the list. A busy port is
// recorded in PinnedErrors, not fatal.
func (g *Gateway) SyncPinned(pinned []PinnedPort) {
	g.mu.Lock()
	cfg := g.cfg
	if cfg == nil {
		g.mu.Unlock()
		return
	}
	cfg.Pinned = pinned
	wanted := make(map[string]int, len(pinned))
	for _, p := range pinned {
		wanted[p.ExitID] = p.Port
	}
	var removed []string
	for id, pl := range g.pinned {
		if port, ok := wanted[id]; !ok || port != pl.port {
			delete(g.pinned, id)
			removed = append(removed, id)
			pl.l.Close()
		}
	}
	for id := range g.pinErrors {
		if _, ok := wanted[id]; !ok {
			delete(g.pinErrors, id)
		}
	}
	for _, p := range pinned {
		if _, ok := g.pinned[p.ExitID]; ok {
			continue
		}
		l, err := g.listen(p.Port, cfg.AllowLAN, p.ExitID)
		if err != nil {
			g.pinErrors[p.ExitID] = portMessage(err, p.Port, "Pick another port for this IP.")
			continue
		}
		g.pinned[p.ExitID] = pinnedListener{port: p.Port, l: l}
		delete(g.pinErrors, p.ExitID)
	}
	g.mu.Unlock()
	for _, id := range removed {
		id := id
		g.Drop(func(c ConnInfo) bool { return c.Pinned == id })
	}
}

func (g *Gateway) Stop() {
	g.mu.Lock()
	var ls []net.Listener
	if g.server != nil {
		ls = append(ls, g.server)
	}
	for _, p := range g.pinned {
		ls = append(ls, p.l)
	}
	g.server = nil
	g.pinned = map[string]pinnedListener{}
	g.pinErrors = map[string]string{}
	g.cfg = nil
	g.mu.Unlock()
	g.active.Store(false)
	for _, l := range ls {
		l.Close()
	}
	g.DropAll()
}

// Drop ends matching open connections so apps reconnect through the current exit.
func (g *Gateway) Drop(match func(ConnInfo) bool) int {
	g.mu.Lock()
	var hit []*conn
	for c := range g.conns {
		if match(ConnInfo{Pinned: c.pinned, ExitID: c.exitInfo()}) {
			hit = append(hit, c)
		}
	}
	g.mu.Unlock()
	for _, c := range hit {
		c.destroy()
	}
	return len(hit)
}

func (g *Gateway) DropAll() int { return g.Drop(func(ConnInfo) bool { return true }) }

// Totals returns cumulative bytes (closed + live connections) and open connections.
func (g *Gateway) Totals() (up, down int64, active int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	up, down = g.closedUp, g.closedDown
	for c := range g.conns {
		up += c.up.Load()
		down += c.down.Load()
		if c.hasEntry.Load() {
			active++
		}
	}
	return
}

// ---- connections ----

// meterConn applies the idle timeout and (optionally) counts bytes.
type meterConn struct {
	net.Conn
	rd, wr *atomic.Int64
}

func (m *meterConn) Read(p []byte) (int, error) {
	_ = m.Conn.SetDeadline(time.Now().Add(idleTimeout))
	n, err := m.Conn.Read(p)
	if m.rd != nil {
		m.rd.Add(int64(n))
	}
	return n, err
}

func (m *meterConn) Write(p []byte) (int, error) {
	_ = m.Conn.SetDeadline(time.Now().Add(idleTimeout))
	n, err := m.Conn.Write(p)
	if m.wr != nil {
		m.wr.Add(int64(n))
	}
	return n, err
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = c.Close()
}

func (m *meterConn) CloseWrite() error {
	if cw, ok := m.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return m.Conn.Close()
}

type conn struct {
	g       *Gateway
	client  *meterConn
	br      *bufio.Reader
	started time.Time
	pinned  string
	local   bool
	port    int
	remote  string

	up, down atomic.Int64
	hasEntry atomic.Bool
	entry    *ActivityEntry // owned by the handler goroutine

	mu       sync.Mutex
	upstream net.Conn
	dead     bool
	exitID   string
}

func (c *conn) exitInfo() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exitID != "" {
		return c.exitID
	}
	return c.pinned
}

func (c *conn) destroy() {
	c.mu.Lock()
	c.dead = true
	up := c.upstream
	c.mu.Unlock()
	c.client.Conn.Close()
	if up != nil {
		up.Close()
	}
}

func (g *Gateway) onConnection(raw net.Conn, pinned string) {
	g.mu.Lock()
	cfg := g.cfg
	var snap Config
	if cfg != nil {
		snap = *cfg
	}
	g.mu.Unlock()
	remote := ""
	if ta, ok := raw.RemoteAddr().(*net.TCPAddr); ok {
		remote = netutil.NormalizeAddress(ta.IP.String())
	}
	local := netutil.IsLoopback(remote)
	if cfg == nil || (!local && !(snap.AllowLAN && netutil.IsPrivate(remote))) {
		raw.Close()
		return
	}
	if tc, ok := raw.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	c := &conn{g: g, started: time.Now(), pinned: pinned, local: local, port: snap.Port, remote: remote}
	c.client = &meterConn{Conn: raw, rd: &c.up, wr: &c.down}
	c.br = bufio.NewReader(c.client)
	g.mu.Lock()
	g.conns[c] = struct{}{}
	g.mu.Unlock()
	defer g.finish(c)
	defer raw.Close()

	var auth *LanAuth
	if !local {
		auth = snap.LanAuth
	}
	g.handle(c, auth)
}

func (g *Gateway) finish(c *conn) {
	g.mu.Lock()
	delete(g.conns, c)
	g.closedUp += c.up.Load()
	g.closedDown += c.down.Load()
	g.mu.Unlock()
	e := c.entry
	if e == nil {
		return
	}
	e.Up = c.up.Load()
	e.Down = c.down.Load()
	e.DurationMs = time.Since(c.started).Milliseconds()
	if e.Status == "open" {
		e.Status = "closed"
	}
	g.emit(e)
}

func (g *Gateway) emit(e *ActivityEntry) {
	g.mu.Lock()
	fn := g.onActivity
	g.mu.Unlock()
	if fn != nil {
		fn(*e)
	}
}

// ActivityEntry aliases the shared type for brevity.
type ActivityEntry = types.ActivityEntry

func (g *Gateway) open(c *conn, kind, host string, port int) *ActivityEntry {
	e := &ActivityEntry{ID: g.nextID.Add(1), At: time.Now().UnixMilli(), Kind: kind, Client: c.remote, Host: host, Port: port, Status: "open"}
	c.entry = e
	c.hasEntry.Store(true)
	g.emit(e)
	return e
}

func (g *Gateway) fail(e *ActivityEntry, err error) {
	e.Status = "failed"
	e.Error = err.Error()
}

type httpHead struct {
	method, target, version string
	headers                 [][2]string
}

func parseHead(text string) *httpHead {
	lines := strings.Split(text, "\r\n")
	parts := strings.Split(lines[0], " ")
	if len(parts) < 3 || parts[0] == "" || parts[1] == "" || !strings.HasPrefix(parts[2], "HTTP/") {
		return nil
	}
	h := &httpHead{method: strings.ToUpper(parts[0]), target: parts[1], version: parts[2]}
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		i := strings.Index(line, ":")
		if i <= 0 {
			continue
		}
		h.headers = append(h.headers, [2]string{strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:])})
	}
	return h
}

func (h *httpHead) header(name string) (string, bool) {
	for _, kv := range h.headers {
		if strings.EqualFold(kv[0], name) {
			return kv[1], true
		}
	}
	return "", false
}

func safeEqual(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func checkBasic(h *httpHead, auth *LanAuth) bool {
	v, _ := h.header("proxy-authorization")
	if len(v) < 6 || !strings.EqualFold(v[:6], "basic ") {
		return false
	}
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(v[6:]))
	dec := string(raw)
	i := strings.Index(dec, ":")
	if i == -1 {
		return false
	}
	return safeEqual(dec[:i], auth.Username) && safeEqual(dec[i+1:], auth.Password)
}

func (g *Gateway) handle(c *conn, auth *LanAuth) {
	first, err := c.br.Peek(1)
	if err != nil {
		return
	}
	switch first[0] {
	case 0x05:
		c.br.Discard(1)
		g.handleSocks(c, auth)
		return
	case 0x04, 0x16:
		return // SOCKS4 and TLS-to-the-proxy are not supported; drop quietly
	}
	raw, err := upstream.ReadHead(c.br, maxHead)
	if err != nil {
		return
	}
	head := parseHead(string(raw))
	if head == nil {
		c.respond(400, "Bad request")
		return
	}
	if head.method == "CONNECT" {
		host, port, ok := netutil.ParseHostPort(head.target, 443)
		if !ok {
			c.respond(400, "Bad CONNECT target")
			return
		}
		if auth != nil && !checkBasic(head, auth) {
			c.respondAuth()
			return
		}
		g.handleConnect(c, host, port)
		return
	}
	if strings.HasPrefix(head.target, "http://") {
		if auth != nil && !checkBasic(head, auth) {
			c.respondAuth()
			return
		}
		g.handlePlainHTTP(c, head)
		return
	}
	if strings.HasPrefix(head.target, "/") {
		g.serveSelf(c, head)
		return
	}
	c.respond(400, "Only http:// URLs can be proxied directly. Use CONNECT for https.")
}

func (g *Gateway) handleSocks(c *conn, auth *LanAuth) {
	var sa *upstream.SocksAuth
	if auth != nil {
		sa = &upstream.SocksAuth{Username: auth.Username, Password: auth.Password}
	}
	host, port, err := upstream.AcceptSocks5(c.client, c.br, sa)
	if err != nil {
		return
	}
	e := g.open(c, "socks", host, port)
	sock, err := g.tunnelFor(c, e, host, port)
	if err != nil {
		g.fail(e, err)
		var ge *gwError
		if errors.As(err, &ge) {
			upstream.SocksReply(c.client, 2)
		} else {
			upstream.SocksReply(c.client, upstream.SocksReplyFor(err))
		}
		c.lingerClose()
		return
	}
	upstream.SocksReply(c.client, 0)
	g.bridge(c, sock, nil)
}

func (g *Gateway) handleConnect(c *conn, host string, port int) {
	e := g.open(c, "connect", host, port)
	sock, err := g.tunnelFor(c, e, host, port)
	if err != nil {
		g.fail(e, err)
		c.respondError(err)
		return
	}
	c.client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	g.bridge(c, sock, nil)
}

var hopByHop = map[string]bool{"proxy-authorization": true, "proxy-connection": true, "connection": true, "keep-alive": true, "te": true, "trailer": true, "upgrade": true}

func (g *Gateway) handlePlainHTTP(c *conn, head *httpHead) {
	u, err := url.Parse(head.target)
	if err != nil || u.Hostname() == "" {
		c.respond(400, "Bad URL")
		return
	}
	host := strings.ToLower(u.Hostname())
	port := 80
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			c.respond(400, "Bad URL")
			return
		}
		port = n
	}
	urlHost := host
	if strings.Contains(host, ":") {
		urlHost = "[" + host + "]"
	}
	if port != 80 {
		urlHost += ":" + strconv.Itoa(port)
	}
	e := g.open(c, "http", host, port)

	route, err := g.routeFor(c, host)
	if err != nil {
		g.fail(e, err)
		c.respondError(err)
		return
	}
	g.noteRoute(c, e, route)
	viaHTTP := route != nil && route.Upstream.Protocol != "socks5"

	var sock net.Conn
	if viaHTTP {
		raw, err := upstream.ConnectProxy(&route.Upstream, 0)
		if err != nil {
			var ue *upstream.Error
			if errors.As(err, &ue) {
				g.hooks.UpstreamResult(ue)
			}
			g.fail(e, err)
			c.respondError(err)
			return
		}
		sock = &meterConn{Conn: raw}
	} else {
		sock, err = g.openVia(route, host, port)
		if err != nil {
			g.fail(e, err)
			c.respondError(err)
			return
		}
	}

	target := u.EscapedPath()
	if target == "" {
		target = "/"
	}
	if u.RawQuery != "" {
		target += "?" + u.RawQuery
	}
	if viaHTTP {
		target = head.target
	}
	lines := []string{head.method + " " + target + " " + head.version}
	hasHost := false
	for _, kv := range head.headers {
		lower := strings.ToLower(kv[0])
		if lower == "host" {
			hasHost = true
		}
		if hopByHop[lower] {
			continue
		}
		lines = append(lines, kv[0]+": "+kv[1])
	}
	if !hasHost {
		lines = append(lines, "Host: "+urlHost)
	}
	if viaHTTP {
		if a := upstream.BasicAuth(route.Upstream.Username, route.Upstream.Password); a != "" {
			lines = append(lines, "Proxy-Authorization: "+a)
		}
	}
	// One request per upstream connection keeps auth and routing simple.
	lines = append(lines, "Connection: close")
	if _, err := sock.Write([]byte(strings.Join(lines, "\r\n") + "\r\n\r\n")); err != nil {
		sock.Close()
		g.fail(e, err)
		c.respondError(err)
		return
	}

	var upR io.Reader
	if viaHTTP {
		// Catch a 407 so the user's app doesn't pop up a login prompt for our upstream.
		ur := bufio.NewReader(sock)
		resHead, err := upstream.ReadHead(ur, maxHead)
		if err != nil {
			sock.Close()
			perr := &upstream.Error{Code: "protocol", Msg: "The proxy closed the connection without answering"}
			g.fail(e, perr)
			c.respondError(perr)
			return
		}
		if upstream.ParseStatus(string(resHead)) == 407 {
			sock.Close()
			perr := upstream.HTTPStatusError(407, urlHost)
			g.hooks.UpstreamResult(perr)
			g.fail(e, perr)
			c.respondError(perr)
			return
		}
		g.hooks.UpstreamResult(nil)
		c.client.Write(resHead)
		upR = ur
	}
	g.bridge(c, sock, upR)
}

var actionRe = regexp.MustCompile(`^/proxy-app/([a-z-]+)$`)
var extOriginRe = regexp.MustCompile(`^(chrome|moz|edge)-extension://`)

func (g *Gateway) serveSelf(c *conn, head *httpHead) {
	path := head.target
	if i := strings.Index(path, "?"); i >= 0 {
		path = path[:i]
	}
	if path == "/proxy.pac" || path == "/wpad.dat" {
		hostHeader, _ := head.header("host")
		address := hostHeader
		if !strings.Contains(hostHeader, ":") {
			address = hostHeader + ":" + strconv.Itoa(c.port)
		}
		c.respondWith(200, g.hooks.PAC(address), "application/x-ns-proxy-autoconfig")
		return
	}
	origin, _ := head.header("origin")
	if path == "/proxy-app.json" {
		// For the browser extension only: this computer, and no web page origins.
		if !c.local || (origin != "" && !extOriginRe.MatchString(origin)) {
			c.respond(403, "Forbidden")
			return
		}
		b, _ := json.Marshal(g.hooks.Status())
		c.respondWith(200, string(b), "application/json", "Cache-Control: no-store")
		return
	}
	if m := actionRe.FindStringSubmatch(path); m != nil && head.method == "POST" {
		// Only from this computer, and only from a browser extension (web pages can't fake Origin).
		if !c.local || origin == "" || !extOriginRe.MatchString(origin) {
			c.respond(403, "Forbidden")
			return
		}
		length := 0
		if v, ok := head.header("content-length"); ok {
			if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
				length = n
			}
		}
		if length > maxHead {
			length = maxHead
		}
		body := map[string]any{}
		if length > 0 {
			buf := make([]byte, length)
			if _, err := io.ReadFull(c.br, buf); err != nil || json.Unmarshal(buf, &body) != nil {
				c.respondWith(400, `{"error":"Bad JSON"}`, "application/json")
				return
			}
			if body == nil {
				body = map[string]any{}
			}
		}
		res, err := g.hooks.Control(m[1], body)
		if err != nil {
			status := 500
			var se *StatusError
			if errors.As(err, &se) {
				status = se.Status
			}
			msg, _ := json.Marshal(map[string]string{"error": err.Error()})
			c.respondWith(status, string(msg), "application/json")
			return
		}
		if res == nil {
			res = map[string]any{"ok": true}
		}
		b, _ := json.Marshal(res)
		c.respondWith(200, string(b), "application/json", "Cache-Control: no-store")
		return
	}
	c.respond(200, "Proxy App gateway is running. Use this address as an HTTP or SOCKS5 proxy.")
}

// routeFor decides where a target goes: nil route = straight out, no exit.
func (g *Gateway) routeFor(c *conn, host string) (*Route, error) {
	if netutil.IsLoopbackTarget(host) && !c.local {
		// A phone on the Wi-Fi must never reach this computer's own services through us.
		return nil, &gwError{403, "Blocked: devices on the network cannot reach this computer through the proxy"}
	}
	if !g.active.Load() {
		return nil, &gwError{503, "Proxy App is off. Connect it in the app, or from the Proxy App button in your browser."}
	}
	if netutil.IsLocalTarget(host) {
		return nil, nil
	}
	r := g.hooks.Route(c.pinned)
	if r == nil {
		if c.pinned != "" {
			return nil, &gwError{503, "This IP was removed from Proxy App."}
		}
		return nil, &gwError{503, "Proxy App has no exit selected. Open the app and pick one."}
	}
	return r, nil
}

func (g *Gateway) noteRoute(c *conn, e *ActivityEntry, r *Route) {
	if r != nil {
		id := r.ExitID
		e.ExitID = &id
		c.mu.Lock()
		c.exitID = id
		c.mu.Unlock()
	}
	e.Direct = r == nil
}

// openVia opens the tunnel for an already-decided route.
func (g *Gateway) openVia(r *Route, host string, port int) (net.Conn, error) {
	if r == nil {
		s, err := upstream.OpenTunnel(nil, host, port, 0)
		if err != nil {
			return nil, err
		}
		return &meterConn{Conn: s}, nil
	}
	s, err := upstream.OpenTunnel(&r.Upstream, host, port, 0)
	if err != nil {
		var ue *upstream.Error
		if errors.As(err, &ue) {
			g.hooks.UpstreamResult(ue)
		}
		return nil, err
	}
	g.hooks.UpstreamResult(nil)
	return &meterConn{Conn: s}, nil
}

func (g *Gateway) tunnelFor(c *conn, e *ActivityEntry, host string, port int) (net.Conn, error) {
	r, err := g.routeFor(c, host)
	if err != nil {
		return nil, err
	}
	g.noteRoute(c, e, r)
	return g.openVia(r, host, port)
}

// bridge pipes client and upstream both ways until both sides are done.
// upR, when set, is a reader holding upstream bytes already buffered.
func (g *Gateway) bridge(c *conn, up net.Conn, upR io.Reader) {
	c.mu.Lock()
	if c.dead {
		c.mu.Unlock()
		up.Close()
		return
	}
	c.upstream = up
	c.mu.Unlock()
	defer up.Close()
	if upR == nil {
		upR = up
	}
	if c.entry != nil {
		g.emit(c.entry)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if _, err := io.Copy(up, c.br); err != nil {
			c.destroy()
			return
		}
		closeWrite(up)
	}()
	go func() {
		defer wg.Done()
		if _, err := io.Copy(c.client, upR); err != nil {
			c.destroy()
			return
		}
		closeWrite(c.client)
	}()
	wg.Wait()
}

// ---- responses ----

var reasons = map[int]string{200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 407: "Proxy Authentication Required", 409: "Conflict", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"}

func (c *conn) respond(status int, body string) {
	c.respondWith(status, body, "text/plain; charset=utf-8")
}

func (c *conn) respondWith(status int, body, ctype string, extra ...string) {
	reason, ok := reasons[status]
	if !ok {
		reason = "Error"
	}
	lines := append([]string{fmt.Sprintf("HTTP/1.1 %d %s", status, reason), "Content-Type: " + ctype, fmt.Sprintf("Content-Length: %d", len(body)), "Connection: close"}, extra...)
	c.client.Write([]byte(strings.Join(lines, "\r\n") + "\r\n\r\n" + body))
	c.lingerClose()
}

// lingerClose half-closes and drains briefly so the client reads the whole
// answer instead of seeing a reset.
func (c *conn) lingerClose() {
	closeWrite(c.client)
	_ = c.client.Conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.CopyN(io.Discard, c.br, 64*1024)
}

func (c *conn) respondAuth() {
	c.respondWith(407, "This proxy needs the gateway login set in Proxy App.", "text/plain; charset=utf-8", `Proxy-Authenticate: Basic realm="Proxy App"`)
}

func (c *conn) respondError(err error) {
	var ge *gwError
	if errors.As(err, &ge) {
		c.respond(ge.status, ge.msg)
		return
	}
	msg := err.Error()
	status := 502
	var ue *upstream.Error
	if errors.As(err, &ue) && ue.Code == "timeout" {
		status = 504
	}
	var clean strings.Builder
	for _, r := range msg {
		if r >= 0x20 && r <= 0x7e {
			clean.WriteRune(r)
		}
	}
	c.respondWith(status, msg, "text/plain; charset=utf-8", "X-Proxy-App-Error: "+clean.String())
}
