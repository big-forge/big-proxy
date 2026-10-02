package sysproxy

import (
	"regexp"
	"runtime"
	"testing"
)

func winRead(name string) string {
	if p := winQuery(name); p != nil {
		return *p
	}
	return "<nil>"
}

// Runs on the Windows CI machine only; it changes the real system proxy and restores it.
func TestWindowsSystemProxyRoundTrip(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	before := map[string]string{"e": winRead("ProxyEnable"), "s": winRead("ProxyServer"), "o": winRead("ProxyOverride")}
	d := ForPlatform()
	snap, err := d.Apply("127.0.0.1", 18899, []string{"localhost", "127.0.0.1", "10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	if winRead("ProxyServer") != "127.0.0.1:18899" || winRead("ProxyEnable") != "0x1" {
		t.Fatal("proxy not applied")
	}
	if !regexp.MustCompile(`<local>`).MatchString(winRead("ProxyOverride")) {
		t.Fatal("override missing <local>")
	}
	if err := d.Restore(snap); err != nil {
		t.Fatal(err)
	}
	wantEnable := before["e"]
	if wantEnable == "<nil>" {
		wantEnable = "0x0"
	}
	if winRead("ProxyEnable") != wantEnable || winRead("ProxyServer") != before["s"] || winRead("ProxyOverride") != before["o"] {
		t.Fatal("not restored exactly")
	}
}
