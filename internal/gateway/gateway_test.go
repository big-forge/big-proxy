package gateway

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
	"github.com/big-forge/big-proxy/internal/upstream"
)

type seenReq struct{ method, target, auth string }

type world struct {
	t                                  *testing.T
	echoPort, targetPort, upstreamPort int
	gatewayPort, pinnedPort            int
	gw                                 *Gateway

	mu       sync.Mutex
	seen     []seenReq
	route    *Route
	upErrs   []*upstream.Error
	control  []string
	activity []types.ActivityEntry
}

func (w *world) lastSeen() seenReq {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.seen[len(w.seen)-1]
}
func (w *world) seenLen() int { w.mu.Lock(); defer w.mu.Unlock(); return len(w.seen) }
func (w *world) setRoute(r *Route) {
	w.mu.Lock()
	w.route = r
	w.mu.Unlock()
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func serve(t *testing.T, h func(net.Conn)) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go h(c)
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func (w *world) endpoint(user string) types.ProxyEndpoint {
	return types.ProxyEndpoint{Protocol: "http", Host: "127.0.0.1", Port: w.upstreamPort, Username: user, Password: "pw"}
}

type hooks struct{ w *world }

func (h hooks) Route(exitID string) *Route {
	if exitID != "" {
		return &Route{Upstream: h.w.endpoint("login-" + exitID), ExitID: exitID}
	}
	h.w.mu.Lock()
	defer h.w.mu.Unlock()
	return h.w.route
}
func (h hooks) PAC(addr string) string { return "PROXY " + addr }
func (h hooks) UpstreamResult(err *upstream.Error) {
	h.w.mu.Lock()
	h.w.upErrs = append(h.w.upErrs, err)
	h.w.mu.Unlock()
}
func (h hooks) Status() types.GatewayStatus {
	return types.GatewayStatus{App: "proxy-app", Version: "test", Connected: true, Port: h.w.gatewayPort, Exits: []types.GatewayStatusExit{}}
}
func (h hooks) Control(action string, body map[string]any) (any, error) {
	h.w.mu.Lock()
	h.w.control = append(h.w.control, action)
	h.w.mu.Unlock()
	return map[string]any{"ok": true}, nil
}

var authRe = regexp.MustCompile(`(?i)Proxy-Authorization: Basic (\S+)`)

func newWorld(t *testing.T) *world {
	w := &world{t: t}
	target := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(rw, "hello from %s%s", r.Host, r.URL.RequestURI())
	}))
	t.Cleanup(target.Close)
	w.targetPort = target.Listener.Addr().(*net.TCPAddr).Port
	w.echoPort = serve(t, func(c net.Conn) { defer c.Close(); io.Copy(c, c) })

	w.upstreamPort = serve(t, func(client net.Conn) {
		defer client.Close()
		br := bufio.NewReader(client)
		head, err := upstream.ReadHead(br, 65536)
		if err != nil {
			return
		}
		text := string(head)
		parts := strings.Split(text, " ")
		method, tgt := parts[0], parts[1]
		login := ""
		if m := authRe.FindStringSubmatch(text); m != nil {
			b, _ := base64.StdEncoding.DecodeString(m[1])
			login = string(b)
		}
		w.mu.Lock()
		w.seen = append(w.seen, seenReq{method, tgt, login})
		w.mu.Unlock()
		if login == "" || strings.HasSuffix(login, ":wrong") {
			client.Write([]byte("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"))
			return
		}
		if method == "CONNECT" {
			port := w.targetPort
			if strings.HasSuffix(tgt, ":7") {
				port = w.echoPort
			}
			out, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(port))
			if err != nil {
				return
			}
			defer out.Close()
			client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
			go func() { io.Copy(out, br); out.(*net.TCPConn).CloseWrite() }()
			io.Copy(client, out)
			return
		}
		// plain request: rewrite absolute URI to a path and relay
		i := strings.Index(tgt[len("http://"):], "/") + len("http://")
		out, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(w.targetPort))
		if err != nil {
			return
		}
		defer out.Close()
		out.Write([]byte(strings.Replace(text, tgt, tgt[i:], 1)))
		go func() { io.Copy(out, br); out.(*net.TCPConn).CloseWrite() }()
		io.Copy(client, out)
	})

	w.gatewayPort = freePort(t)
	w.pinnedPort = freePort(t)
	w.gw = New(hooks{w})
	w.gw.OnActivity(func(e types.ActivityEntry) {
		w.mu.Lock()
		w.activity = append(w.activity, e)
		w.mu.Unlock()
	})
	if err := w.gw.Start(Config{Port: w.gatewayPort, Pinned: []PinnedPort{{"pinned", w.pinnedPort}}}); err != nil {
		t.Fatal(err)
	}
	w.gw.SetActive(true)
	t.Cleanup(w.gw.Stop)
	return w
}

func (w *world) connectVia(host string, port, via int) (net.Conn, int) {
	w.t.Helper()
	if via == 0 {
		via = w.gatewayPort
	}
	c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(via))
	if err != nil {
		w.t.Fatal(err)
	}
	fmt.Fprintf(c, "CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n", host, port, host, port)
	return c, readStatus(w.t, c)
}

// readStatus reads exactly the response head (so later reads see tunnel data).
func readStatus(t *testing.T, c net.Conn) int {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var buf []byte
	b := make([]byte, 1)
	for !strings.HasSuffix(string(buf), "\r\n\r\n") {
		if _, err := c.Read(b); err != nil {
			t.Fatalf("read status: %v (got %q)", err, buf)
		}
		buf = append(buf, b[0])
	}
	n, _ := strconv.Atoi(strings.Split(string(buf), " ")[1])
	return n
}

func roundTrip(t *testing.T, c net.Conn, s string) string {
	t.Helper()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(s))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	return string(buf)
}

func (w *world) waitIdle() {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, n := w.gw.Totals(); n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (w *world) get(path string, headers map[string]string) (int, string) {
	req, _ := http.NewRequest("GET", "http://127.0.0.1:"+strconv.Itoa(w.gatewayPort)+path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestGateway(t *testing.T) {
	w := newWorld(t)

	t.Run("CONNECT goes through the active exit with its login", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-a"), ExitID: "a"})
		c, status := w.connectVia("remote.example", 7, 0)
		defer c.Close()
		if status != 200 {
			t.Fatal(status)
		}
		if roundTrip(t, c, "ping") != "ping" {
			t.Fatal("echo")
		}
		if got := w.lastSeen(); got != (seenReq{"CONNECT", "remote.example:7", "exit-a:pw"}) {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("SOCKS5 clients are tunnelled through the same exit", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-b"), ExitID: "b"})
		c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(w.gatewayPort))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		c.Write([]byte{5, 1, 0})
		r := make([]byte, 2)
		io.ReadFull(c, r)
		if r[0] != 5 || r[1] != 0 {
			t.Fatal(r)
		}
		name := "remote.example"
		req := append([]byte{5, 1, 0, 3, byte(len(name))}, name...)
		c.Write(append(req, 0, 7))
		reply := make([]byte, 10)
		if _, err := io.ReadFull(c, reply); err != nil || reply[1] != 0 {
			t.Fatalf("socks reply %v %v", reply, err)
		}
		if roundTrip(t, c, "hi") != "hi" {
			t.Fatal("echo")
		}
		if w.lastSeen().auth != "exit-b:pw" {
			t.Fatal(w.lastSeen())
		}
	})

	t.Run("plain HTTP is forwarded with the upstream login", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-c"), ExitID: "c"})
		c, _ := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(w.gatewayPort))
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		fmt.Fprintf(c, "GET http://site.example/page?q=1 HTTP/1.1\r\nHost: site.example\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\n\r\n")
		all, _ := io.ReadAll(c)
		if !strings.HasSuffix(string(all), "hello from site.example/page?q=1") {
			t.Fatalf("%q", all)
		}
		if got := w.lastSeen(); got != (seenReq{"GET", "http://site.example/page?q=1", "exit-c:pw"}) {
			t.Fatalf("%+v", got)
		}
	})

	t.Run("a rejected upstream login becomes a 502", func(t *testing.T) {
		ep := w.endpoint("exit-d")
		ep.Password = "wrong"
		w.setRoute(&Route{Upstream: ep, ExitID: "d"})
		c, status := w.connectVia("remote.example", 7, 0)
		defer c.Close()
		if status != 502 {
			t.Fatal(status)
		}
		w.mu.Lock()
		last := w.upErrs[len(w.upErrs)-1]
		w.mu.Unlock()
		if last == nil || last.Code != "auth" {
			t.Fatal(last)
		}
	})

	t.Run("rejected login on plain HTTP never forwards the 407", func(t *testing.T) {
		ep := w.endpoint("exit-d")
		ep.Password = "wrong"
		w.setRoute(&Route{Upstream: ep, ExitID: "d"})
		c, _ := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(w.gatewayPort))
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		fmt.Fprintf(c, "GET http://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n")
		all, _ := io.ReadAll(c)
		if !strings.HasPrefix(string(all), "HTTP/1.1 502") || !strings.Contains(string(all), "X-Proxy-App-Error: The proxy rejected the login") {
			t.Fatalf("%q", all)
		}
	})

	t.Run("local targets skip the exit entirely", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-e"), ExitID: "e"})
		before := w.seenLen()
		c, status := w.connectVia("127.0.0.1", w.echoPort, 0)
		defer c.Close()
		if status != 200 || roundTrip(t, c, "direct") != "direct" {
			t.Fatal(status)
		}
		if w.seenLen() != before {
			t.Fatal("upstream saw local traffic")
		}
	})

	t.Run("no exit selected gives a clear 503", func(t *testing.T) {
		w.setRoute(nil)
		c, status := w.connectVia("remote.example", 7, 0)
		defer c.Close()
		if status != 503 {
			t.Fatal(status)
		}
	})

	t.Run("dropAll closes open tunnels", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-f"), ExitID: "f"})
		c, _ := w.connectVia("remote.example", 7, 0)
		defer c.Close()
		if w.gw.DropAll() < 1 {
			t.Fatal("nothing dropped")
		}
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := c.Read(make([]byte, 1)); err == nil {
			t.Fatal("expected closed")
		}
		if up, _, _ := w.gw.Totals(); up <= 0 {
			t.Fatal("totals up should be > 0")
		}
	})

	t.Run("serves a PAC file", func(t *testing.T) {
		_, body := w.get("/proxy.pac", nil)
		if body != fmt.Sprintf("PROXY 127.0.0.1:%d", w.gatewayPort) {
			t.Fatal(body)
		}
	})

	t.Run("a pinned port keeps its own exit", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-main"), ExitID: "main"})
		c, status := w.connectVia("remote.example", 7, w.pinnedPort)
		defer c.Close()
		if status != 200 || w.lastSeen().auth != "login-pinned:pw" {
			t.Fatal(status, w.lastSeen())
		}
	})

	t.Run("switching drops main-port connections but leaves pinned ones", func(t *testing.T) {
		w.waitIdle()
		w.setRoute(&Route{Upstream: w.endpoint("exit-main"), ExitID: "main"})
		main, _ := w.connectVia("remote.example", 7, 0)
		defer main.Close()
		pinned, _ := w.connectVia("remote.example", 7, w.pinnedPort)
		defer pinned.Close()
		if n := w.gw.Drop(func(c ConnInfo) bool { return c.Pinned == "" }); n != 1 {
			t.Fatalf("dropped %d", n)
		}
		main.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := main.Read(make([]byte, 1)); err == nil {
			t.Fatal("main should be closed")
		}
		if roundTrip(t, pinned, "still here") != "still here" {
			t.Fatal("pinned broke")
		}
	})

	t.Run("pinned ports open and close with the exit list", func(t *testing.T) {
		w.gw.SyncPinned(nil)
		if c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(w.pinnedPort)); err == nil {
			c.Close()
			t.Fatal("pinned port should be closed")
		}
		w.gw.SyncPinned([]PinnedPort{{"pinned", w.pinnedPort}})
		c, status := w.connectVia("remote.example", 7, w.pinnedPort)
		defer c.Close()
		if status != 200 {
			t.Fatal(status)
		}
	})

	t.Run("a busy pinned port is reported, not fatal", func(t *testing.T) {
		sq, _ := net.Listen("tcp", "127.0.0.1:0")
		busy := sq.Addr().(*net.TCPAddr).Port
		w.gw.SyncPinned([]PinnedPort{{"pinned", w.pinnedPort}, {"other", busy}})
		if msg := w.gw.PinnedErrors()["other"]; !strings.Contains(msg, "already in use") {
			t.Fatalf("got %q", msg)
		}
		sq.Close()
		w.gw.SyncPinned([]PinnedPort{{"pinned", w.pinnedPort}})
		if _, ok := w.gw.PinnedErrors()["other"]; ok {
			t.Fatal("error should be cleared")
		}
	})

	t.Run("status for the browser extension", func(t *testing.T) {
		code, body := w.get("/proxy-app.json", map[string]string{"Origin": "chrome-extension://abcdefghijklmnop"})
		var st types.GatewayStatus
		json.Unmarshal([]byte(body), &st)
		if code != 200 || st.App != "proxy-app" {
			t.Fatal(code, body)
		}
		if code, _ := w.get("/proxy-app.json", nil); code != 200 {
			t.Fatal("no Origin should be allowed", code)
		}
		if code, _ := w.get("/proxy-app.json", map[string]string{"Origin": "https://evil.example"}); code != 403 {
			t.Fatal(code)
		}
	})

	post := func(path string, headers map[string]string) int {
		req, _ := http.NewRequest("POST", "http://127.0.0.1:"+strconv.Itoa(w.gatewayPort)+path, strings.NewReader("{}"))
		req.Header.Set("content-type", "application/json")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	t.Run("extension actions only from extension origins", func(t *testing.T) {
		if post("/proxy-app/connect", map[string]string{"Origin": "chrome-extension://abc"}) != 200 {
			t.Fatal("extension origin")
		}
		if post("/proxy-app/connect", map[string]string{"Origin": "https://evil.example"}) != 403 || post("/proxy-app/connect", nil) != 403 {
			t.Fatal("must be refused")
		}
		w.mu.Lock()
		defer w.mu.Unlock()
		if len(w.control) != 1 || w.control[0] != "connect" {
			t.Fatal(w.control)
		}
	})

	t.Run("standby refuses traffic but still answers the extension", func(t *testing.T) {
		w.setRoute(&Route{Upstream: w.endpoint("exit-x"), ExitID: "x"})
		w.gw.SetActive(false)
		c, status := w.connectVia("remote.example", 7, 0)
		c.Close()
		if status != 503 {
			t.Fatal(status)
		}
		if code, _ := w.get("/proxy-app.json", nil); code != 200 {
			t.Fatal(code)
		}
		w.gw.SetActive(true)
	})

	t.Run("activity is reported", func(t *testing.T) {
		w.mu.Lock()
		defer w.mu.Unlock()
		var sawClosed bool
		for _, e := range w.activity {
			if e.Status == "closed" && e.ExitID != nil && e.Kind == "connect" {
				sawClosed = true
			}
		}
		if !sawClosed {
			t.Fatalf("no closed entry in %d events", len(w.activity))
		}
	})
}

func TestLanAuthAndStartErrors(t *testing.T) {
	w := newWorld(t)
	busy, _ := net.Listen("tcp", "127.0.0.1:0")
	defer busy.Close()
	err := New(hooks{w}).Start(Config{Port: busy.Addr().(*net.TCPAddr).Port})
	if err == nil || !strings.Contains(err.Error(), "is already in use by another app. Pick a different port in Settings.") {
		t.Fatalf("got %v", err)
	}
	// Loopback clients never need the LAN login: restart with one set.
	if err := w.gw.Start(Config{Port: w.gatewayPort, LanAuth: &LanAuth{"u", "p"}}); err != nil {
		t.Fatal(err)
	}
	w.gw.SetActive(true)
	w.setRoute(&Route{Upstream: w.endpoint("exit-a"), ExitID: "a"})
	c, status := w.connectVia("remote.example", 7, 0)
	defer c.Close()
	if status != 200 {
		t.Fatal(status)
	}
}
