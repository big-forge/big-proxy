package upstream

import (
	"bufio"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
)

func listen(t *testing.T, h func(net.Conn)) int {
	t.Helper()
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

func echoServer(t *testing.T) int {
	return listen(t, func(c net.Conn) { defer c.Close(); io.Copy(c, c) })
}

func roundTrip(t *testing.T, c net.Conn, s string) string {
	t.Helper()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, len(s))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	return string(buf)
}

func httpProxy(t *testing.T, echo int, wantAuth string, early bool) int {
	return listen(t, func(c net.Conn) {
		br := bufio.NewReader(c)
		head, err := ReadHead(br, 16384)
		if err != nil {
			c.Close()
			return
		}
		if !strings.Contains(string(head), "Proxy-Authorization: "+wantAuth) {
			c.Write([]byte("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"))
			c.Close()
			return
		}
		out, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(echo))
		if err != nil {
			c.Close()
			return
		}
		resp := "HTTP/1.1 200 Connection Established\r\n\r\n"
		if early {
			resp += "EARLY"
		}
		c.Write([]byte(resp))
		go io.Copy(out, br)
		io.Copy(c, out)
		c.Close()
	})
}

func TestHTTPConnect(t *testing.T) {
	echo := echoServer(t)
	p := httpProxy(t, echo, BasicAuth("u", "pw"), true)
	up := &types.ProxyEndpoint{Protocol: "http", Host: "127.0.0.1", Port: p, Username: "u", Password: "pw"}
	c, err := OpenTunnel(up, "remote.example", 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// bytes the proxy sent right behind the 200 are not lost
	if got := roundTrip(t, c, ""); got != "" {
		t.Fatal(got)
	}
	buf := make([]byte, 5)
	io.ReadFull(c, buf)
	if string(buf) != "EARLY" {
		t.Fatalf("early bytes lost: %q", buf)
	}
	if got := roundTrip(t, c, "ping"); got != "ping" {
		t.Fatal(got)
	}
}

func TestHTTPConnectAuthRejected(t *testing.T) {
	p := httpProxy(t, 1, BasicAuth("u", "pw"), false)
	up := &types.ProxyEndpoint{Protocol: "http", Host: "127.0.0.1", Port: p, Username: "u", Password: "bad"}
	_, err := OpenTunnel(up, "remote.example", 7, 0)
	ue, ok := err.(*Error)
	if !ok || ue.Code != "auth" || ue.Status != 407 || ue.Msg != "The proxy rejected the login. Check the username and password." {
		t.Fatalf("got %#v", err)
	}
}

func TestRefusedAndDirect(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	_, err := OpenTunnel(&types.ProxyEndpoint{Protocol: "http", Host: "127.0.0.1", Port: port}, "x.example", 80, time.Second)
	if ue, ok := err.(*Error); !ok || ue.Code != "refused" {
		t.Fatalf("got %#v", err)
	}
	echo := echoServer(t)
	c, err := OpenTunnel(nil, "127.0.0.1", echo, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if roundTrip(t, c, "hi") != "hi" {
		t.Fatal("echo")
	}
}

func TestProxyTimeout(t *testing.T) {
	p := listen(t, func(c net.Conn) { time.Sleep(2 * time.Second); c.Close() })
	_, err := OpenTunnel(&types.ProxyEndpoint{Protocol: "http", Host: "127.0.0.1", Port: p}, "x.example", 80, 200*time.Millisecond)
	if ue, ok := err.(*Error); !ok || ue.Code != "timeout" || ue.Msg != "The proxy took too long to respond" {
		t.Fatalf("got %#v", err)
	}
}

func socksProxy(t *testing.T, echo int, user, pass string) int {
	return listen(t, func(c net.Conn) {
		defer c.Close()
		br := bufio.NewReader(c)
		ver, _ := br.ReadByte()
		if ver != 5 {
			return
		}
		var auth *SocksAuth
		if user != "" {
			auth = &SocksAuth{user, pass}
		}
		_, port, err := AcceptSocks5(c, br, auth)
		if err != nil {
			return
		}
		_ = port
		out, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(echo))
		if err != nil {
			SocksReply(c, 5)
			return
		}
		SocksReply(c, 0)
		go io.Copy(out, br)
		io.Copy(c, out)
	})
}

func TestSocks5ClientAndServer(t *testing.T) {
	echo := echoServer(t)
	p := socksProxy(t, echo, "u", "pw")
	for _, host := range []string{"remote.example", "1.2.3.4", "::1"} {
		up := &types.ProxyEndpoint{Protocol: "socks5", Host: "127.0.0.1", Port: p, Username: "u", Password: "pw"}
		c, err := OpenTunnel(up, host, 7, 0)
		if err != nil {
			t.Fatal(host, err)
		}
		if roundTrip(t, c, "hello") != "hello" {
			t.Fatal("echo")
		}
		c.Close()
	}
	bad := &types.ProxyEndpoint{Protocol: "socks5", Host: "127.0.0.1", Port: p, Username: "u", Password: "no"}
	if _, err := OpenTunnel(bad, "x.example", 7, 0); err == nil || err.(*Error).Code != "auth" {
		t.Fatalf("got %v", err)
	}
	noAuth := socksProxy(t, echo, "", "")
	c, err := OpenTunnel(&types.ProxyEndpoint{Protocol: "socks5", Host: "127.0.0.1", Port: noAuth}, "x.example", 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func TestSocksReplyFor(t *testing.T) {
	cases := map[string]byte{"refused": 5, "unreachable": 4, "target": 4, "timeout": 4, "auth": 2, "protocol": 1}
	for code, want := range cases {
		if got := SocksReplyFor(&Error{Code: code}); got != want {
			t.Errorf("%s: %d", code, got)
		}
	}
	if SocksReplyFor(io.EOF) != 1 {
		t.Error("generic")
	}
}

func TestBasicAuthAndStatus(t *testing.T) {
	if BasicAuth("", "") != "" || BasicAuth("a", "b") != "Basic YTpi" {
		t.Error("BasicAuth")
	}
	if e := HTTPStatusError(403, "h:1"); e.Code != "target" || e.Msg != "The proxy blocked h:1" {
		t.Error(e)
	}
	if e := HTTPStatusError(503, "h:1"); e.Msg != "The proxy couldn't reach h:1 (503)" {
		t.Error(e)
	}
	if e := HTTPStatusError(418, "h:1"); e.Code != "protocol" || e.Msg != "The proxy answered with status 418" {
		t.Error(e)
	}
}
