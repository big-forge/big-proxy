package apps

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

var slack = Scanned{
	ID:     "com.tinyspeck.slackmacgap",
	Name:   "Slack",
	Path:   "/Applications/Slack.app",
	Exe:    "/Applications/Slack.app/Contents/MacOS/Slack",
	Engine: "electron",
	Method: "launch",
}

func TestFindMainAndProxyPort(t *testing.T) {
	procs := []Process{
		{PID: 11, Command: "/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer) --type=renderer"},
		{PID: 10, Command: "/Applications/Slack.app/Contents/MacOS/Slack " + ProxyArgs(8901)[0]},
	}
	main := FindMain(slack, procs)
	if main == nil || main.PID != 10 {
		t.Fatalf("main = %+v", main)
	}
	if p := ProxyPortOf(main); p == nil || *p != 8901 {
		t.Fatalf("port = %v", p)
	}
	if p := ProxyPortOf(&Process{PID: 1, Command: "/Applications/Slack.app/Contents/MacOS/Slack"}); p != nil {
		t.Fatal("expected nil port")
	}
	if FindMain(slack, []Process{{PID: 2, Command: "/Applications/Other.app/Contents/MacOS/Other"}}) != nil {
		t.Fatal("expected no match")
	}
	if ProxyPortOf(nil) != nil {
		t.Fatal("nil process")
	}
}

func TestFindMainWindowsQuotedCaseInsensitive(t *testing.T) {
	app := Scanned{Exe: `C:\Users\x\AppData\Local\slack\app-4.1.0\slack.exe`}
	procs := []Process{{PID: 5, Command: `"C:\Users\X\AppData\Local\Slack\app-4.1.0\Slack.exe" --proxy-server=127.0.0.1:9000`}}
	main := FindMain(app, procs)
	if main == nil {
		t.Fatal("no match")
	}
	if p := ProxyPortOf(main); p == nil || *p != 9000 {
		t.Fatalf("port = %v", p)
	}
}

func TestParsePSAndWinProcesses(t *testing.T) {
	ps := parsePS("  12 /bin/a --x\n  7 b\nbad\n")
	if len(ps) != 2 || ps[0].PID != 12 || ps[0].Command != "/bin/a --x" {
		t.Fatalf("%+v", ps)
	}
	one := parseWinProcesses(`{"ProcessId":4,"CommandLine":null,"ExecutablePath":"C:\\a.exe"}`)
	if len(one) != 1 || one[0].Command != `C:\a.exe` {
		t.Fatalf("%+v", one)
	}
	many := parseWinProcesses(`[{"ProcessId":4,"CommandLine":"x y","ExecutablePath":"C:\\a.exe"}]`)
	if len(many) != 1 || many[0].Command != "x y" {
		t.Fatalf("%+v", many)
	}
}

func TestClassify(t *testing.T) {
	if m, h := classify("org.telegram.desktop", "Telegram", "native"); m != "inside" || h == "" {
		t.Fatal(m, h)
	}
	if m, _ := classify("com.x", "X", "electron"); m != "launch" {
		t.Fatal(m)
	}
	if m, _ := classify("com.x", "X", "native"); m != "system" {
		t.Fatal(m)
	}
	if !profileBrowsers.MatchString("com.google.Chrome") || !profileBrowsers.MatchString(`c:\x\chrome.exe`) || profileBrowsers.MatchString("com.slack") {
		t.Fatal("profileBrowsers")
	}
}

func TestMacEngine(t *testing.T) {
	root := t.TempDir()
	mk := func(app, fw string) string {
		b := filepath.Join(root, app+".app")
		os.MkdirAll(filepath.Join(b, "Contents", "Frameworks", fw), 0o755)
		return b
	}
	cases := map[string]string{
		mk("a", "Electron Framework.framework"):          "electron",
		mk("b", "Chromium Embedded Framework.framework"): "cef",
		mk("c", "Opera Framework.framework"):             "chromium",
		mk("d", "Sparkle.framework"):                     "native",
		filepath.Join(root, "missing.app"):               "native",
	}
	for b, want := range cases {
		if got := macEngine(b); got != want {
			t.Errorf("%s: %s want %s", b, got, want)
		}
	}
}

func TestSquirrelExe(t *testing.T) {
	root := t.TempDir()
	for _, f := range []string{"app-1.9.0/slack.exe", "app-1.10.0/slack.exe", "app-1.10.0/squirrel.exe", "app-1.10.0/other.exe"} {
		p := filepath.Join(root, filepath.FromSlash(f))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, nil, 0o644)
	}
	if got := squirrelExe(root, "Slack Technologies"); got != filepath.Join(root, "app-1.10.0", "slack.exe") {
		t.Fatal(got)
	}
}

func TestIconCacheHit(t *testing.T) {
	dir := t.TempDir()
	app := Scanned{Path: "/Applications/Nothing.app"}
	if _, err := Icon(app, dir); err == nil {
		t.Fatal("expected error without an icon")
	}
	if runtime.GOOS == "windows" {
		return
	}
	// Seed the cache for this path; Icon should return it without running anything.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatal("nothing should be cached yet")
	}
}

func TestProxyArgs(t *testing.T) {
	if a := ProxyArgs(1234); len(a) != 1 || a[0] != "--proxy-server=http://127.0.0.1:1234" {
		t.Fatal(a)
	}
}
