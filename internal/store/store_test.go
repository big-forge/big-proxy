package store

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/big-forge/big-proxy/internal/types"
)

func TestRoundTripAndMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "d")
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Data.Settings.GatewayPort != 8899 || !s.Data.Settings.DropOnSwitch || s.Data.Settings.LanAuth.Username != "proxy" {
		t.Fatalf("defaults %+v", s.Data.Settings)
	}
	id := "x1"
	s.Mu.Lock()
	s.Data.Accounts = append(s.Data.Accounts, types.Account{ID: "a", Provider: "dataimpulse", Username: "u"})
	s.Data.ActiveExitID = &id
	s.Data.Settings.GatewayPort = 9000
	s.Mu.Unlock()
	s.Save()
	s.Save()
	s.Flush()

	if runtime.GOOS != "windows" {
		st, err := os.Stat(s.File)
		if err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v %v", st, err)
		}
	}
	s2, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.Data.Accounts) != 1 || s2.Data.Accounts[0].ID != "a" || *s2.Data.ActiveExitID != "x1" || s2.Data.Settings.GatewayPort != 9000 {
		t.Fatalf("%+v", s2.Data)
	}
}

func TestBrokenFileRenamed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Data.Exits) != 0 || s.Data.Settings.GatewayPort != 8899 {
		t.Fatal("fresh config expected")
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "config.json.broken-*"))
	if len(matches) != 1 {
		t.Fatalf("broken files: %v", matches)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); err == nil {
		t.Fatal("broken config.json should be gone")
	}
}

func TestDefaultsMergedOverPartial(t *testing.T) {
	dir := t.TempDir()
	old := `{"version":1,"accounts":null,"exits":null,"activeExitId":null,"appRules":null,
"settings":{"gatewayPort":1234,"lanAuth":{"enabled":true},"bypass":null,"future":1},"extra":true}`
	os.WriteFile(filepath.Join(dir, "config.json"), []byte(old), 0o600)
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	d := s.Data
	if d.Accounts == nil || d.Exits == nil || d.AppRules == nil {
		t.Fatal("nil collections")
	}
	st := d.Settings
	if st.GatewayPort != 1234 || !st.LanAuth.Enabled || st.LanAuth.Username != "proxy" || st.Theme != "system" || !st.DropOnSwitch || len(st.Bypass) != len(DefaultBypass) {
		t.Fatalf("%+v", st)
	}
	if d.Usage.Since == 0 {
		t.Fatal("usage.since")
	}
}

func TestSideFiles(t *testing.T) {
	s, _ := New(t.TempDir())
	var got map[string]int
	if s.ReadJSON("x.json", &got) {
		t.Fatal("should be missing")
	}
	if err := s.WriteJSON("x.json", map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if !s.ReadJSON("x.json", &got) || got["a"] != 1 {
		t.Fatal("round trip")
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(filepath.Join(s.Dir, "x.json")); st.Mode().Perm() != 0o600 {
			t.Fatal("mode")
		}
	}
	s.Remove("x.json")
	if s.ReadJSON("x.json", &got) {
		t.Fatal("removed")
	}
}

func TestDefaultDataDir(t *testing.T) {
	if !strings.HasSuffix(DefaultDataDir(), "Proxy App") {
		t.Fatal(DefaultDataDir())
	}
}
