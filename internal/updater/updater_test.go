package updater

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/big-forge/big-proxy/internal/types"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.2.0", "0.1.0", true}, {"0.1.1", "0.1.0", true}, {"1.0.0", "0.9.9", true}, {"0.10.0", "0.9.0", true},
		{"0.1.0", "0.1.0", false}, {"0.1.0", "0.2.0", false}, {"0.2.0", "dev", false}, {"v0.3.0", "0.2.9", true},
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestUnzipRejectsEscapingPaths(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "evil.zip")
	f, _ := os.Create(zp)
	w := zip.NewWriter(f)
	e, _ := w.Create("../escape.txt")
	e.Write([]byte("x"))
	w.Close()
	f.Close()
	if err := unzip(zp, filepath.Join(dir, "out")); err == nil {
		t.Fatal("expected an error for a path that escapes the folder")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.txt")); err == nil {
		t.Fatal("file escaped the destination folder")
	}
}

func TestUnzipKeepsAppBundleShape(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "app.zip")
	f, _ := os.Create(zp)
	w := zip.NewWriter(f)
	hdr := &zip.FileHeader{Name: "Proxy App.app/Contents/MacOS/Proxy App", Method: zip.Deflate}
	hdr.SetMode(0o755)
	e, _ := w.CreateHeader(hdr)
	e.Write([]byte("#!/bin/sh\n"))
	w.Close()
	f.Close()
	out := filepath.Join(dir, "out")
	if err := unzip(zp, out); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(out, "Proxy App.app", "Contents", "MacOS", "Proxy App"))
	if err != nil || st.Mode().Perm()&0o100 == 0 {
		t.Fatalf("executable bit lost: %v %v", st, err)
	}
}

// A whole update against a fake GitHub: find the release, download, verify, swap, relaunch.
func TestEndToEndUpdate(t *testing.T) {
	if assetName("1.0.0") == "" {
		t.Skip("self-update is not supported on this system")
	}
	// The "new build": an app bundle (macOS) or a single exe (Windows).
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	if runtime.GOOS == "darwin" {
		hdr := &zip.FileHeader{Name: "Proxy App.app/Contents/MacOS/Proxy App", Method: zip.Deflate}
		hdr.SetMode(0o755)
		w, _ := zw.CreateHeader(hdr)
		w.Write([]byte("NEW BUILD"))
	} else {
		w, _ := zw.Create("Proxy App.exe")
		w.Write([]byte("NEW BUILD"))
	}
	zw.Close()
	asset := assetName("0.2.0")
	sum := sha256.Sum256(buf.Bytes())

	var srv *httptest.Server
	badSum := false
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/o/r/releases/latest":
			fmt.Fprintf(w, `{"tag_name":"v0.2.0","assets":[{"name":%q,"browser_download_url":%q},{"name":"SHA256SUMS","browser_download_url":%q}]}`,
				asset, srv.URL+"/dl/"+asset, srv.URL+"/dl/SHA256SUMS")
		case "/dl/" + asset:
			w.Write(buf.Bytes())
		case "/dl/SHA256SUMS":
			s := hex.EncodeToString(sum[:])
			if badSum {
				s = strings.Repeat("0", 64)
			}
			fmt.Fprintf(w, "%s  %s\n", s, asset)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	apiBase = srv.URL
	defer func() { apiBase = "https://api.github.com" }()

	// The "installed app" being replaced.
	dir := t.TempDir()
	var target, exe string
	if runtime.GOOS == "darwin" {
		target = filepath.Join(dir, "Proxy App.app")
		exe = filepath.Join(target, "Contents", "MacOS", "Proxy App")
		os.MkdirAll(filepath.Dir(exe), 0o755)
	} else {
		target = filepath.Join(dir, "Proxy App.exe")
		exe = target
	}
	os.WriteFile(exe, []byte("OLD BUILD"), 0o755)

	var states []string
	var relaunched string
	u := New("o/r", "0.1.0", func(s types.UpdateState) { states = append(states, s.Status) }, func(p string) { relaunched = p })
	u.exe = exe

	// A tampered download must never be installed.
	badSum = true
	u.Check(true)
	if got := u.state.Status; got != "error" || !strings.Contains(u.state.Error, "checksum") {
		t.Fatalf("tampered build: status=%q error=%q", got, u.state.Error)
	}
	badSum = false

	u.Check(true)
	if u.state.Status != "ready" || u.state.Version != "0.2.0" {
		t.Fatalf("expected a ready 0.2.0 update, got %+v (states %v)", u.state, states)
	}
	if err := u.Install(); err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(target)
	got, _ := filepath.EvalSymlinks(relaunched)
	if got != want {
		t.Fatalf("relaunch got %q want %q", got, want)
	}
	if runtime.GOOS == "darwin" {
		exe = filepath.Join(target, "Contents", "MacOS", "Proxy App")
	}
	if b, _ := os.ReadFile(exe); string(b) != "NEW BUILD" {
		t.Fatalf("the new build is not in place: %q", b)
	}
	if b, _ := os.ReadFile(oldExe(target, exe)); string(b) != "OLD BUILD" {
		t.Fatalf("the old build wasn't kept for cleanup: %q", b)
	}
}

func oldExe(target, exe string) string {
	rel, _ := filepath.Rel(target, exe)
	return filepath.Join(target+".old", rel)
}
