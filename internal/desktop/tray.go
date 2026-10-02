// Package desktop is the menu bar / notification-area icon and the app window.
package desktop

import (
	"fmt"

	"fyne.io/systray"

	"github.com/big-forge/big-proxy/internal/core"
	"github.com/big-forge/big-proxy/internal/types"
)

const maxExits = 15

type Options struct {
	Core *core.Core
	URL  string // where the UI is served
	Quit func() // called after the user chooses Quit
}

// Run shows the tray icon and blocks until Quit. It must be called from the main goroutine.
func Run(o Options) {
	systray.Run(func() { ready(o) }, func() {})
}

// Quit ends Run.
func Quit() { systray.Quit() }

func ready(o Options) {
	c := o.Core
	systray.SetTooltip("Proxy App")
	setIcon(false)

	status := systray.AddMenuItem("Not connected", "")
	status.Disable()
	toggle := systray.AddMenuItem("Connect", "")
	systray.AddSeparator()
	slots := make([]*systray.MenuItem, maxExits)
	ids := make([]string, maxExits)
	for i := range slots {
		slots[i] = systray.AddMenuItemCheckbox("", "", false)
		slots[i].Hide()
	}
	more := systray.AddMenuItem("", "")
	more.Disable()
	more.Hide()
	systray.AddSeparator()
	rotate := systray.AddMenuItem("New IP", "")
	systray.AddSeparator()
	open := systray.AddMenuItem("Open Proxy App", "")
	quit := systray.AddMenuItem("Quit Proxy App", "")

	var on bool
	lastOn := false
	render := func(s types.AppState) {
		on = s.Status == "on"
		if on != lastOn {
			lastOn = on
			setIcon(on)
		}
		active := ""
		if s.ActiveExitID != nil {
			active = *s.ActiveExitID
		}
		var cur *types.Exit
		for i := range s.Exits {
			if s.Exits[i].ID == active {
				cur = &s.Exits[i]
			}
		}
		ip := ""
		if cur != nil && cur.LastCheck != nil && cur.LastCheck.Info != nil {
			ip = cur.LastCheck.Info.IP
		}
		switch {
		case on && ip != "":
			status.SetTitle("Connected: " + ip)
			systray.SetTooltip("Proxy App: connected via " + ip)
		case on:
			status.SetTitle("Connected")
			systray.SetTooltip("Proxy App: connected")
		case s.Status == "connecting":
			status.SetTitle("Connecting…")
		default:
			status.SetTitle("Not connected")
			systray.SetTooltip("Proxy App: not connected")
		}
		if on {
			toggle.SetTitle("Disconnect")
			toggle.Enable()
		} else {
			toggle.SetTitle("Connect")
			if cur != nil {
				toggle.Enable()
			} else {
				toggle.Disable()
			}
		}
		for i := range slots {
			if i >= len(s.Exits) {
				ids[i] = ""
				slots[i].Hide()
				continue
			}
			e := s.Exits[i]
			ids[i] = e.ID
			title := e.Name
			if e.LastCheck != nil && e.LastCheck.Info != nil {
				title = fmt.Sprintf("%s    %s", e.Name, e.LastCheck.Info.IP)
			}
			slots[i].SetTitle(title)
			if e.ID == active {
				slots[i].Check()
			} else {
				slots[i].Uncheck()
			}
			slots[i].Show()
		}
		if extra := len(s.Exits) - maxExits; extra > 0 {
			more.SetTitle(fmt.Sprintf("%d more in the app…", extra))
			more.Show()
		} else {
			more.Hide()
		}
		if on && cur != nil && cur.Kind == "provider" && cur.Mode == "sticky" {
			rotate.Enable()
		} else {
			rotate.Disable()
		}
	}

	render(c.State())
	events, cancel := c.Subscribe()
	go func() {
		defer cancel()
		for e := range events {
			if e.Kind == "state" && e.State != nil {
				render(*e.State)
			}
		}
	}()

	for i := range slots {
		i := i
		go func() {
			for range slots[i].ClickedCh {
				if ids[i] != "" {
					_, _ = c.ActivateExit(ids[i])
				}
			}
		}()
	}
	go func() {
		for {
			select {
			case <-toggle.ClickedCh:
				if on {
					_, _ = c.Disconnect()
				} else {
					_, _ = c.Connect()
				}
			case <-rotate.ClickedCh:
				if id := c.State().ActiveExitID; id != nil {
					_, _ = c.RotateExit(*id)
				}
			case <-open.ClickedCh:
				OpenWindow(o.URL)
			case <-more.ClickedCh:
				OpenWindow(o.URL)
			case <-quit.ClickedCh:
				if o.Quit != nil {
					o.Quit()
				}
				systray.Quit()
				return
			}
		}
	}()
}

func setIcon(on bool) {
	tmpl, reg := trayIcon(on)
	if tmpl != nil {
		systray.SetTemplateIcon(tmpl, reg)
	}
}
