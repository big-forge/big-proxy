package browsers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/big-forge/big-proxy/internal/types"
)

func find1(ps []types.BrowserProfile, name string) types.BrowserProfile {
	for _, p := range ps {
		if p.Name == name {
			return p
		}
	}
	return types.BrowserProfile{}
}

func TestFirefoxManagedBlock(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "Profiles", "abc.default-release"), 0o755)
	os.MkdirAll(filepath.Join(root, "Profiles", "xyz.work"), 0o755)
	os.WriteFile(filepath.Join(root, "profiles.ini"), []byte("[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n[Profile1]\nName=work\nIsRelative=1\nPath=Profiles/xyz.work\n"), 0o644)
	userJs := filepath.Join(root, "Profiles", "xyz.work", "user.js")
	os.WriteFile(userJs, []byte("user_pref(\"browser.startup.page\", 3);\n"), 0o644)

	ps := ListFirefoxProfiles(root)
	if len(ps) != 2 || ps[0].Name != "default-release" || ps[1].Name != "work" || ps[0].Extension != "missing" || ps[1].Extension != "missing" || ps[0].Kind != "prefs" {
		t.Fatalf("%+v", ps)
	}

	port := 8899
	if err := setFirefoxProxyIn(root, "Profiles/xyz.work", &port); err != nil {
		t.Fatal(err)
	}
	if err := setFirefoxProxyIn(root, "Profiles/xyz.work", &port); err != nil { // idempotent
		t.Fatal(err)
	}
	on, _ := os.ReadFile(userJs)
	if n := strings.Count(string(on), "BEGIN Proxy App"); n != 1 {
		t.Fatalf("%d blocks:\n%s", n, on)
	}
	if !strings.Contains(string(on), `"network.proxy.http_port", 8899`) || !strings.Contains(string(on), "browser.startup.page") {
		t.Fatalf("bad content:\n%s", on)
	}
	ps = ListFirefoxProfiles(root)
	if find1(ps, "work").Extension != "on" || find1(ps, "default-release").Extension != "missing" {
		t.Fatalf("%+v", ps)
	}

	if err := setFirefoxProxyIn(root, "Profiles/xyz.work", nil); err != nil {
		t.Fatal(err)
	}
	off, _ := os.ReadFile(userJs)
	if !regexp.MustCompile(`"network\.proxy\.type", 5`).Match(off) || strings.Contains(string(off), "http_port") || strings.Count(string(off), "BEGIN Proxy App") != 1 {
		t.Fatalf("bad reset:\n%s", off)
	}
	if find1(ListFirefoxProfiles(root), "work").Extension != "missing" {
		t.Fatal("expected missing after reset")
	}
	if err := setFirefoxProxyIn(root, "Profiles/nope", &port); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestChromePreferencesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	orig := `{"big":12345678901234567890,"float":1.5e-7,"html":"<a>&","webrtc":{"other":true},"nested":{"a":[1,2,{"b":null}]}}`
	file := filepath.Join(dir, "Preferences")
	os.WriteFile(file, []byte(orig), 0o600)

	if PrefsProxyPort(dir) != nil {
		t.Fatal("no proxy yet")
	}
	port := 8123
	if err := WriteProfilePrefs(dir, &port, "Chrome"); err != nil {
		t.Fatal(err)
	}
	if p := PrefsProxyPort(dir); p == nil || *p != 8123 {
		t.Fatalf("port %v", p)
	}
	data, _ := os.ReadFile(file)
	for _, want := range []string{"12345678901234567890", "1.5e-7", `"<a>&"`, `"other":true`, "disable_non_proxied_udp", `"bypass_list":"<local>"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("missing %q in %s", want, data)
		}
	}
	if _, err := os.Stat(file + ".proxy-app.tmp"); err == nil {
		t.Error("tmp file left behind")
	}

	if err := WriteProfilePrefs(dir, nil, "Chrome"); err != nil {
		t.Fatal(err)
	}
	if PrefsProxyPort(dir) != nil {
		t.Fatal("proxy should be gone")
	}
	var m map[string]any
	data, _ = os.ReadFile(file)
	json.Unmarshal(data, &m)
	if _, ok := m["proxy"]; ok {
		t.Fatal("proxy key remains")
	}
	if w := m["webrtc"].(map[string]any); w["other"] != true || w["ip_handling_policy"] != nil {
		t.Fatalf("webrtc %v", w)
	}
	if !strings.Contains(string(data), "12345678901234567890") {
		t.Fatal("big number mangled")
	}

	// A foreign proxy, and a foreign webrtc policy, are left alone on remove.
	os.WriteFile(file, []byte(`{"proxy":{"mode":"fixed_servers","server":"1.2.3.4:80"},"webrtc":{"ip_handling_policy":"default"}}`), 0o600)
	if PrefsProxyPort(dir) != nil {
		t.Fatal("foreign proxy is not ours")
	}
	WriteProfilePrefs(dir, nil, "")
	data, _ = os.ReadFile(file)
	if !strings.Contains(string(data), `"default"`) {
		t.Fatalf("policy dropped: %s", data)
	}

	if err := WriteProfilePrefs(filepath.Join(dir, "missing"), &port, "Edge"); err == nil || !strings.Contains(err.Error(), "Edge") {
		t.Fatalf("err %v", err)
	}
}

func TestPrefsProxyPortForms(t *testing.T) {
	dir := t.TempDir()
	for body, want := range map[string]int{
		`{"proxy":{"mode":"fixed_servers","server":"http://127.0.0.1:9001"}}`: 9001,
		`{"proxy":{"mode":"fixed_servers","server":"127.0.0.1:9002"}}`:        9002,
		`{"proxy":{"mode":"system","server":"127.0.0.1:9003"}}`:               0,
		`not json`: 0,
	} {
		os.WriteFile(filepath.Join(dir, "Preferences"), []byte(body), 0o600)
		p := PrefsProxyPort(dir)
		if (p == nil) != (want == 0) || (p != nil && *p != want) {
			t.Errorf("%s -> %v", body, p)
		}
	}
}

func TestExtensionState(t *testing.T) {
	dir, ext := t.TempDir(), t.TempDir()
	write := func(body string) { os.WriteFile(filepath.Join(dir, "Secure Preferences"), []byte(body), 0o600) }
	if extensionState(dir, ext) != "missing" {
		t.Fatal("missing expected")
	}
	q, _ := json.Marshal(ext)
	write(`{"extensions":{"settings":{"abc":{"path":` + string(q) + `,"state":1}}}}`)
	if got := extensionState(dir, ext); got != "on" {
		t.Fatal(got)
	}
	write(`{"extensions":{"settings":{"abc":{"path":` + string(q) + `,"state":0}}}}`)
	if got := extensionState(dir, ext); got != "disabled" {
		t.Fatal(got)
	}
	write(`{"extensions":{"settings":{"abc":{"path":` + string(q) + `,"disable_reasons":[1]}}}}`)
	if got := extensionState(dir, ext); got != "disabled" {
		t.Fatal(got)
	}
	write(`{"extensions":{"settings":{"abc":{"path":` + string(q) + `,"disable_reasons":[]}}}}`)
	if got := extensionState(dir, ext); got != "on" {
		t.Fatal(got)
	}
}

func TestUnknownBrowser(t *testing.T) {
	if WriteProfileProxy("netscape", "Default", nil) == nil || OpenProfile("netscape", "Default", "x") == nil || BrowserApp("netscape") != nil {
		t.Fatal("unknown browser should fail")
	}
}
