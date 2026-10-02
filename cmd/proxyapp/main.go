// Command proxyapp runs Proxy App. By default it lives in the menu bar / system tray and
// shows its window on demand; with --web it only serves the UI on http://127.0.0.1:8898.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	bigproxy "github.com/big-forge/big-proxy"
	"github.com/big-forge/big-proxy/internal/core"
	"github.com/big-forge/big-proxy/internal/desktop"
	"github.com/big-forge/big-proxy/internal/secure"
	"github.com/big-forge/big-proxy/internal/server"
	"github.com/big-forge/big-proxy/internal/store"
	"github.com/big-forge/big-proxy/internal/updater"
)

// version is set at build time: -ldflags "-X main.version=0.2.0".
var version = "dev"

func init() {
	// Menu bar APIs must run on the main thread.
	runtime.LockOSThread()
}

// shell lets the UI's buttons reach the tray app (open window, quit, update).
type shell struct {
	url string
	up  *updater.Updater
}

func (s *shell) Show() { desktop.OpenWindow(s.url) }
func (s *shell) Hide() {}
func (s *shell) Quit() { desktop.Quit() }
func (s *shell) UpdateCheck() {
	if s.up != nil {
		go s.up.Check(true)
	}
}
func (s *shell) UpdateInstall() {
	if s.up != nil {
		go func() { _ = s.up.Install() }()
	}
}
func (s *shell) UpdatePage() {
	if s.up != nil {
		s.up.OpenPage()
	}
}

// relaunch starts the freshly installed build once this process has quit, then ends this one.
func relaunch(path string) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", `ping -n 3 127.0.0.1 >nul & "`+path+`"`)
	} else {
		cmd = exec.Command("/bin/sh", "-c", `sleep 2; open -n "$0"`, path)
	}
	_ = cmd.Start()
	desktop.Quit()
}

func main() {
	port := flag.Int("port", 8898, "port for the UI (the proxy gateway port is set in the app)")
	dataDir := flag.String("data-dir", "", "where config.json lives (default: the usual per-user folder)")
	web := flag.Bool("web", false, "no tray icon: just serve the UI and open it in a browser tab")
	hidden := flag.Bool("hidden", false, "start in the tray without opening the window")
	noOpen := flag.Bool("no-open", false, "with --web, don't open a browser tab")
	dev := flag.Bool("dev", false, "serve only the API; run the Vite dev server for the UI")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Proxy App %s\n\nUsage: proxyapp [--web] [--hidden] [--port 8898] [--data-dir <dir>]\n\n", version)
		flag.PrintDefaults()
	}
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		dir = store.DefaultDataDir()
	}

	// A second launch just shows the window of the one already running.
	if !*dev {
		if url := desktop.RunningInstance(dir); url != "" {
			if !*hidden {
				desktop.OpenWindow(url)
			}
			return
		}
	}

	shellName := "app"
	if *web || *dev {
		shellName = "web"
	}
	c, err := core.New(core.Options{DataDir: dir, Shell: shellName, Version: version, Extension: bigproxy.Extension()})
	if err != nil {
		fatal(err)
	}
	c.Init()

	sh := &shell{}
	opts := server.Options{Core: c, Port: *port, Token: secure.RandomToken(24)}
	if !*web && !*dev {
		opts.Shell = sh
	}
	if *dev {
		opts.Token = "dev-token"
	} else {
		opts.UI = bigproxy.UI()
	}
	var srv *server.Server
	for try := 0; try < 10; try++ {
		srv, err = server.Start(opts)
		if err == nil || *dev {
			break
		}
		opts.Port++
	}
	if err != nil {
		fatal(fmt.Errorf("ports %d-%d are all busy; pass --port to pick another", *port, *port+9))
	}
	sh.url = srv.URL
	if !*web && !*dev {
		updater.CleanOld()
		sh.up = updater.New("big-forge/big-proxy", version, c.SetUpdate, relaunch)
		sh.up.Start()
	}
	if !*dev {
		defer desktop.RegisterInstance(dir, srv.URL)()
	}

	var login *bool
	apply := func() {
		want := c.State().Settings.LaunchAtLogin
		if login == nil || *login != want {
			login = &want
			_ = desktop.SetLaunchAtLogin(want)
		}
	}
	if !*web && !*dev {
		apply()
	}

	stop := func() {
		c.Shutdown()
		srv.Close()
	}

	if *web || *dev {
		shown := srv.URL
		if *dev {
			shown = "http://localhost:5173/  (Vite dev server)"
		}
		fmt.Printf("\n  Proxy App %s is running\n\n  Open      %s\n  Gateway   127.0.0.1:%d  (HTTP + SOCKS5, once you connect)\n  Config    %s\n\n  Press Ctrl+C to stop. Your previous system proxy settings come back on exit.\n\n",
			version, shown, c.State().Settings.GatewayPort, filepath.Join(dir, "config.json"))
		if !*dev && !*noOpen {
			desktop.OpenWindow(srv.URL)
		}
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		fmt.Println("\n  Stopping. Restoring system proxy settings…")
		stop()
		return
	}

	// Desktop mode: tray on the main thread; the window opens on demand.
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		desktop.Quit()
	}()
	if !*hidden {
		go desktop.OpenWindow(srv.URL)
	}
	// Keep "open at login" in step with the Settings switch.
	events, cancel := c.Subscribe()
	defer cancel()
	go func() {
		for e := range events {
			if e.Kind == "state" {
				apply()
			}
		}
	}()
	desktop.Run(desktop.Options{Core: c, URL: srv.URL})
	stop()
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "\n  Proxy App couldn't start: %v\n\n", err)
	os.Exit(1)
}
