package netutil

import "testing"

func TestAddressHelpers(t *testing.T) {
	for addr, want := range map[string]bool{
		"192.168.1.20": true, "100.101.1.2": true, "8.8.8.8": false, "::ffff:10.1.2.3": true,
		"127.0.0.1": true, "172.16.0.1": true, "172.32.0.1": false, "fd00::1": true, "2001:db8::1": false, "": false,
	} {
		if got := IsPrivate(addr); got != want {
			t.Errorf("IsPrivate(%q)=%v want %v", addr, got, want)
		}
	}
	if !IsLoopback("::ffff:127.0.0.1") || !IsLoopback("::1") || IsLoopback("10.0.0.1") {
		t.Error("IsLoopback")
	}
	if !IsLocalTarget("printer.local") || IsLocalTarget("example.com") || !IsLocalTarget("[::1]") || !IsLocalTarget("10.0.0.2") {
		t.Error("IsLocalTarget")
	}
	if !IsLoopbackTarget("foo.localhost") || IsLoopbackTarget("10.0.0.2") || !IsLoopbackTarget("127.0.0.5") {
		t.Error("IsLoopbackTarget")
	}
	if FormatHostPort("::1", 80) != "[::1]:80" || FormatHostPort("a.b", 80) != "a.b:80" {
		t.Error("FormatHostPort")
	}
}

func TestParseHostPort(t *testing.T) {
	type c struct {
		in   string
		def  int
		host string
		port int
		ok   bool
	}
	for _, tc := range []c{
		{"[::1]:443", 0, "::1", 443, true},
		{"example.com", 443, "example.com", 443, true},
		{"example.com", 0, "", 0, false},
		{"a.com:99999", 0, "", 0, false},
		{"a.com:80", 0, "a.com", 80, true},
		{"[::1]", 443, "::1", 443, true},
		{"[::1", 443, "", 0, false},
		{":80", 0, "", 0, false},
	} {
		h, p, ok := ParseHostPort(tc.in, tc.def)
		if h != tc.host || p != tc.port || ok != tc.ok {
			t.Errorf("%q: got %q %d %v", tc.in, h, p, ok)
		}
	}
}

func TestLanAddresses(t *testing.T) { _ = LanAddresses() }
