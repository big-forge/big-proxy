package providers

import (
	"testing"

	"github.com/big-forge/big-proxy/internal/types"
)

func TestBuildLogin(t *testing.T) {
	cases := []struct {
		o    LoginOptions
		want string
	}{
		{LoginOptions{}, "abc"},
		{LoginOptions{Country: "IN"}, "abc__cr.in"},
		{LoginOptions{Country: "us", City: "New York", Session: "s1", SessionMinutes: 60}, "abc__cr.us;city.newyork;sessid.s1;sessttl.60"},
		{LoginOptions{SessionMinutes: 60}, "abc"},
	}
	for _, c := range cases {
		if got := BuildLogin("dataimpulse", "abc", c.o); got != c.want {
			t.Errorf("got %q want %q", got, c.want)
		}
	}
	if CitySlug("São Paulo") != "saopaulo" || CitySlug("Zürich-Nord 2") != "zurichnord2" {
		t.Error("slug")
	}
}

func TestParseLoginDetect(t *testing.T) {
	b, c, ci := ParseLogin("dataimpulse", "abc123__cr.US,gb;city.Mumbai;sessid.x")
	if b != "abc123" || c != "us" || ci != "mumbai" {
		t.Errorf("%q %q %q", b, c, ci)
	}
	if b, _, _ := ParseLogin("dataimpulse", "plain"); b != "plain" {
		t.Error("plain")
	}
	if Detect("gw.dataimpulse.com") != "dataimpulse" || Detect("DataImpulse.com") != "dataimpulse" || Detect("notdataimpulse.com") != "" {
		t.Error("detect")
	}
	if Name("dataimpulse") != "DataImpulse" {
		t.Error("name")
	}
}

func TestUpstreamFor(t *testing.T) {
	acc := []types.Account{{ID: "a1", Provider: "dataimpulse", Protocol: "http", Host: "gw.dataimpulse.com", Port: 823, Username: "u", Password: "p"}}
	ex := types.Exit{Kind: "provider", AccountID: "a1", Mode: "sticky", Country: "in", Session: "s", SessionMinutes: 30}
	if u := UpstreamFor(ex, acc); u == nil || u.Username != "u__cr.in;sessid.s;sessttl.30" || u.Password != "p" || u.Port != 823 {
		t.Errorf("%+v", u)
	}
	ex.Mode = "rotating"
	if u := UpstreamFor(ex, acc); u.Username != "u__cr.in" {
		t.Errorf("%+v", u)
	}
	ex.AccountID = "gone"
	if UpstreamFor(ex, acc) != nil {
		t.Error("expected nil")
	}
	px := &types.ProxyEndpoint{Host: "h", Port: 1}
	if UpstreamFor(types.Exit{Kind: "proxy", Proxy: px}, nil) != px {
		t.Error("proxy exit")
	}
}
