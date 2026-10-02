package ipcheck

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
	"github.com/big-forge/big-proxy/internal/upstream"
)

func serve(resp string) net.Conn {
	a, b := net.Pipe()
	go func() {
		buf := make([]byte, 4096)
		b.Read(buf)
		b.Write([]byte(resp))
		b.Close()
	}()
	return a
}

func TestParse(t *testing.T) {
	i, err := parseIPAPI(`{"status":"success","query":"1.2.3.4","countryCode":"in","country":" India ","regionName":"MH","city":"","isp":"X"}`)
	if err != nil || i.IP != "1.2.3.4" || i.CountryCode != "IN" || i.Country != "India" || i.City != "" {
		t.Fatalf("%+v %v", i, err)
	}
	if _, err := parseIPAPI(`{"status":"fail","message":"reserved range"}`); err == nil || err.Error() != "reserved range" {
		t.Fatal(err)
	}
	w, err := parseIPWho(`{"success":true,"ip":"5.6.7.8","country_code":"us","connection":{"org":"Org"}}`)
	if err != nil || w.CountryCode != "US" || w.ISP != "Org" {
		t.Fatalf("%+v %v", w, err)
	}
	if _, err := parseIPWho(`{"success":false,"message":"nope"}`); err == nil {
		t.Fatal("expected error")
	}
}

func TestHTTPGet(t *testing.T) {
	body, err := httpGet(serve("HTTP/1.0 200 OK\r\nX: y\r\n\r\n{\"a\":1}"), "h", "/")
	if err != nil || body != `{"a":1}` {
		t.Fatalf("%q %v", body, err)
	}
	if _, err := httpGet(serve("HTTP/1.0 403 Forbidden\r\n\r\n"), "h", "/"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatal(err)
	}
}

func withTunnel(t *testing.T, f func(*types.ProxyEndpoint, string, int, time.Duration) (net.Conn, error)) {
	old := openTunnel
	openTunnel = f
	t.Cleanup(func() { openTunnel = old })
}

func TestCheckOK(t *testing.T) {
	withTunnel(t, func(_ *types.ProxyEndpoint, host string, port int, _ time.Duration) (net.Conn, error) {
		return serve(`HTTP/1.0 200 OK` + "\r\n\r\n" + `{"status":"success","query":"9.9.9.9","countryCode":"de"}`), nil
	})
	c := Check(types.ProxyEndpoint{Host: "p", Port: 1})
	if !c.OK || c.Info.IP != "9.9.9.9" || c.Info.CountryCode != "DE" || c.At == 0 {
		t.Fatalf("%+v", c)
	}
}

func TestCheckAuthErrorNoFallback(t *testing.T) {
	calls := 0
	withTunnel(t, func(*types.ProxyEndpoint, string, int, time.Duration) (net.Conn, error) {
		calls++
		return nil, &upstream.Error{Code: "auth", Msg: "bad login"}
	})
	c := Check(types.ProxyEndpoint{})
	if c.OK || c.ErrorCode != "auth" || c.Error != "bad login" || calls != 1 {
		t.Fatalf("%+v calls=%d", c, calls)
	}
}

func TestCheckFallbackFailure(t *testing.T) {
	calls := 0
	withTunnel(t, func(*types.ProxyEndpoint, string, int, time.Duration) (net.Conn, error) {
		calls++
		if calls == 1 {
			return nil, &upstream.Error{Code: "target", Msg: "blocked"}
		}
		return nil, &upstream.Error{Code: "timeout", Msg: "slow"}
	})
	c := Check(types.ProxyEndpoint{})
	if c.OK || c.ErrorCode != "timeout" || calls != 2 {
		t.Fatalf("%+v calls=%d", c, calls)
	}
}
