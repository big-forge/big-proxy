// Package updater keeps the app current from GitHub Releases. It downloads the new
// build itself and swaps it in place, so it works for unsigned apps too (a file we
// download ourselves is not quarantined by macOS).
package updater

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
)

const releasesPage = "https://github.com/%s/releases/latest"

// apiBase is a variable only so tests can point it at a local server.
var apiBase = "https://api.github.com"

// Updater checks, downloads and installs updates, reporting through Report.
type Updater struct {
	Repo    string // owner/name
	Current string // running version, "dev" disables installing
	Report  func(types.UpdateState)
	// Relaunch is called after the new build is in place; it should start it and quit.
	Relaunch func(path string)

	mu       sync.Mutex
	state    types.UpdateState
	staged   string // downloaded, verified build waiting to be installed
	checking bool
	exe      string // tests only: pretend the running executable is here
}

func New(repo, current string, report func(types.UpdateState), relaunch func(string)) *Updater {
	u := &Updater{Repo: repo, Current: current, Report: report, Relaunch: relaunch}
	u.state = types.UpdateState{Status: "idle", CanInstall: u.target() != ""}
	u.Report(u.state)
	return u
}

func (u *Updater) set(patch func(*types.UpdateState)) {
	u.mu.Lock()
	patch(&u.state)
	s := u.state
	u.mu.Unlock()
	u.Report(s)
}

// Start checks shortly after launch and then every six hours.
func (u *Updater) Start() {
	go func() {
		time.Sleep(15 * time.Second)
		for {
			u.Check(false)
			time.Sleep(6 * time.Hour)
		}
	}()
}

// OpenPage opens the releases page (used when this build can't update itself).
func (u *Updater) OpenPage() {
	url := fmt.Sprintf(releasesPage, u.Repo)
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

type release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

// assetName is the build for this system, e.g. Proxy-App-0.2.0-mac-arm64.zip.
func assetName(version string) string {
	switch runtime.GOOS {
	case "darwin":
		arch := "x64"
		if runtime.GOARCH == "arm64" {
			arch = "arm64"
		}
		return fmt.Sprintf("Proxy-App-%s-mac-%s.zip", version, arch)
	case "windows":
		return fmt.Sprintf("Proxy-App-%s-windows-x64.zip", version)
	}
	return ""
}

// Check looks for a newer version. A manual check reports problems; a background one stays quiet.
func (u *Updater) Check(manual bool) {
	u.mu.Lock()
	if u.checking || u.state.Status == "downloading" || u.state.Status == "ready" {
		u.mu.Unlock()
		return
	}
	u.checking = true
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.checking = false; u.mu.Unlock() }()

	u.set(func(s *types.UpdateState) { s.Status, s.Error = "checking", "" })
	rel, err := u.latest()
	if err != nil {
		u.set(func(s *types.UpdateState) {
			if manual {
				s.Status, s.Error = "error", err.Error()
			} else {
				s.Status = "idle"
			}
		})
		return
	}
	version := strings.TrimPrefix(rel.Tag, "v")
	if !newer(version, u.Current) {
		u.set(func(s *types.UpdateState) { s.Status, s.Version, s.CheckedAt = "none", "", time.Now().UnixMilli() })
		return
	}
	if u.target() == "" {
		u.set(func(s *types.UpdateState) {
			s.Status, s.Version, s.CheckedAt = "available", version, time.Now().UnixMilli()
		})
		return
	}
	u.set(func(s *types.UpdateState) {
		s.Status, s.Version, s.Progress, s.CheckedAt = "downloading", version, 0, time.Now().UnixMilli()
	})
	path, err := u.download(rel, version)
	if err != nil {
		u.set(func(s *types.UpdateState) {
			if manual {
				s.Status, s.Error = "error", err.Error()
			} else {
				s.Status = "available" // let the user fetch it by hand
			}
		})
		return
	}
	u.mu.Lock()
	u.staged = path
	u.mu.Unlock()
	u.set(func(s *types.UpdateState) { s.Status, s.Progress = "ready", 100 })
}

func (u *Updater) latest() (*release, error) {
	req, _ := http.NewRequest("GET", apiBase+"/repos/"+u.Repo+"/releases/latest", nil)
	req.Header.Set("User-Agent", "proxy-app-updater")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, errors.New("couldn't reach GitHub")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, errors.New("no release has been published yet")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var rel release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, errors.New("couldn't read the release information")
	}
	return &rel, nil
}

// download fetches the build and checks it against the release's SHA256SUMS.
func (u *Updater) download(rel *release, version string) (string, error) {
	want := assetName(version)
	var url, sums string
	for _, a := range rel.Assets {
		switch a.Name {
		case want:
			url = a.URL
		case "SHA256SUMS":
			sums = a.URL
		}
	}
	if url == "" {
		return "", fmt.Errorf("this release has no build for your system (%s)", want)
	}
	expected := ""
	if sums != "" {
		expected = fetchSum(sums, want)
	}
	if expected == "" {
		return "", errors.New("the release has no checksum for this build, so it was not installed")
	}

	tmp, err := os.CreateTemp("", "proxy-app-update-*.zip")
	if err != nil {
		return "", err
	}
	defer tmp.Close()
	resp, err := (&http.Client{}).Get(url)
	if err != nil {
		return "", errors.New("the download failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("the download failed (%d)", resp.StatusCode)
	}
	h := sha256.New()
	var done int64
	buf := make([]byte, 64*1024)
	last := -1
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				return "", werr
			}
			done += int64(n)
			if resp.ContentLength > 0 {
				if p := int(done * 100 / resp.ContentLength); p != last && p%2 == 0 {
					last = p
					u.set(func(s *types.UpdateState) { s.Progress = p })
				}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", errors.New("the download was interrupted")
		}
	}
	if hex.EncodeToString(h.Sum(nil)) != expected {
		_ = os.Remove(tmp.Name())
		return "", errors.New("the download didn't match its checksum, so it was not installed")
	}
	return tmp.Name(), nil
}

func fetchSum(url, name string) string {
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

// target is what gets replaced: the .app bundle on macOS, the executable on Windows.
// Empty means this build can't update itself (a dev build, Linux, or a read-only install).
func (u *Updater) target() string {
	if u.Current == "dev" {
		return ""
	}
	exe := u.exe
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return ""
		}
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	switch runtime.GOOS {
	case "darwin":
		app := filepath.Dir(filepath.Dir(filepath.Dir(exe))) // X.app/Contents/MacOS/exe
		if !strings.HasSuffix(app, ".app") || !writable(filepath.Dir(app)) {
			return ""
		}
		return app
	case "windows":
		if !writable(filepath.Dir(exe)) {
			return ""
		}
		return exe
	}
	return ""
}

func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".pa-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	return os.Remove(name) == nil
}

// Install swaps the downloaded build in and relaunches.
func (u *Updater) Install() error {
	u.mu.Lock()
	zipPath, target := u.staged, u.target()
	u.mu.Unlock()
	if zipPath == "" || target == "" {
		return errors.New("there is no update ready to install")
	}
	staging, err := os.MkdirTemp(filepath.Dir(target), ".pa-new-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := unzip(zipPath, staging); err != nil {
		return err
	}
	var fresh string
	if runtime.GOOS == "darwin" {
		fresh = filepath.Join(staging, "Proxy App.app")
	} else {
		fresh = filepath.Join(staging, "Proxy App.exe")
	}
	if _, err := os.Stat(fresh); err != nil {
		return errors.New("the update didn't contain the app")
	}
	old := target + ".old"
	_ = os.RemoveAll(old)
	// Renaming a running app/exe is allowed on both systems; the new one takes its place.
	if err := os.Rename(target, old); err != nil {
		return err
	}
	if err := os.Rename(fresh, target); err != nil {
		_ = os.Rename(old, target) // put the old one back
		return err
	}
	_ = os.Remove(zipPath)
	if u.Relaunch != nil {
		u.Relaunch(target)
	}
	return nil
}

// CleanOld removes the previous build left behind by the last update.
func CleanOld() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	if runtime.GOOS == "darwin" {
		exe = filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	}
	_ = os.RemoveAll(exe + ".old")
}

func unzip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range r.File {
		p := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(p, root) {
			return errors.New("the update contained an unsafe path")
		}
		switch {
		case f.FileInfo().IsDir():
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case f.Mode()&os.ModeSymlink != 0:
			rc, err := f.Open()
			if err != nil {
				return err
			}
			target, _ := io.ReadAll(rc)
			rc.Close()
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(string(target), p); err != nil {
				return err
			}
		default:
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			rc, err := f.Open()
			if err != nil {
				return err
			}
			out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode().Perm())
			if err != nil {
				rc.Close()
				return err
			}
			_, err = io.Copy(out, rc)
			rc.Close()
			out.Close()
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// newer reports whether a is a higher dotted version than b ("dev" is never older).
func newer(a, b string) bool {
	if b == "dev" {
		return false
	}
	pa, pb := nums(a), nums(b)
	for i := 0; i < 3; i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func nums(v string) []int {
	var out []int
	for _, p := range strings.Split(strings.TrimPrefix(v, "v"), ".") {
		n, err := strconv.Atoi(strings.SplitN(p, "-", 2)[0])
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	return out
}
