package parse

import (
	"reflect"
	"testing"

	"github.com/big-forge/big-proxy/internal/types"
)

func TestFormats(t *testing.T) {
	want := &types.ParsedProxy{ProxyEndpoint: types.ProxyEndpoint{Protocol: "http", Host: "1.2.3.4", Port: 8080, Username: "user", Password: "pa:ss"}}
	if got := ParseProxyLine("http://user:pa:ss@1.2.3.4:8080"); !reflect.DeepEqual(got, want) {
		t.Errorf("%+v", got)
	}
	if p := ParseProxyLine("socks5://u:p@proxy.example.com:1080"); p == nil || p.Protocol != "socks5" {
		t.Error("socks5")
	}
	if p := ParseProxyLine("socks5h://u:p@h.example:1080"); p == nil || p.Protocol != "socks5" {
		t.Error("socks5h")
	}
	want = &types.ParsedProxy{ProxyEndpoint: types.ProxyEndpoint{Protocol: "http", Host: "proxy.example.com", Port: 3128, Username: "alice", Password: "secret"}}
	if got := ParseProxyLine("proxy.example.com:3128:alice:secret"); !reflect.DeepEqual(got, want) {
		t.Errorf("%+v", got)
	}
	if p := ParseProxyLine("alice:secret:proxy.example.com:3128"); p == nil || p.Host != "proxy.example.com" {
		t.Error("user:pass:host:port")
	}
	if p := ParseProxyLine("10.0.0.5:8888"); p == nil || p.Port != 8888 {
		t.Error("host:port")
	}
	if p := ParseProxyLine("http://u%40x:p%3Aw@h.example:80/"); p == nil || p.Username != "u@x" || p.Password != "p:w" {
		t.Errorf("decode %+v", p)
	}
	for _, bad := range []string{"not a proxy", "ftp://a:b@c:21", "host:99999", "", "# c"} {
		if ParseProxyLine(bad) != nil {
			t.Errorf("%q should be nil", bad)
		}
	}
}

func TestDataImpulse(t *testing.T) {
	p := ParseProxyLine("abc123__cr.in;city.mumbai;sessid.x:pw@gw.dataimpulse.com:823")
	if p == nil || p.Provider != "dataimpulse" || p.Username != "abc123" || p.Country != "in" || p.City != "mumbai" || p.Password != "pw" {
		t.Errorf("%+v", p)
	}
}

func TestList(t *testing.T) {
	parsed, invalid := ParseProxyList("# comment\r\n1.1.1.1:80\r\n\r\ngarbage\nu:p@h.example:1")
	if len(parsed) != 2 || !reflect.DeepEqual(invalid, []string{"garbage"}) {
		t.Errorf("%d %v", len(parsed), invalid)
	}
}
