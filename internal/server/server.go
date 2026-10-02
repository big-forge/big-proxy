// Package server is the control API the UI and the desktop shell use. It
// listens on 127.0.0.1 only; every API request needs the per-launch token and a
// loopback Host header, which keeps websites (CSRF, DNS rebinding) from driving it.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/big-forge/big-proxy/internal/core"
	"github.com/big-forge/big-proxy/internal/secure"
	"github.com/big-forge/big-proxy/internal/types"
)

// Shell is implemented by the desktop wrapper (window, tray, updater). Nil in web mode.
type Shell interface {
	Show()
	Hide()
	Quit()
	UpdateCheck()
	UpdateInstall()
	UpdatePage()
}

type Options struct {
	Core  *core.Core
	Port  int // 0 = pick a free one
	UI    fs.FS
	Token string
	Shell Shell
}

type Server struct {
	Port int
	URL  string
	srv  *http.Server
}

func (s *Server) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.srv.Shutdown(ctx); err != nil {
		_ = s.srv.Close()
	}
}

type handler func(r *http.Request, params []string, body map[string]any) (any, error)

type route struct {
	method  string
	pattern *regexp.Regexp
	fn      handler
}

var securityHeaders = map[string]string{
	"Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options":  "nosniff",
	"Referrer-Policy":         "no-referrer",
	"X-Frame-Options":         "DENY",
}

func rx(p string) *regexp.Regexp { return regexp.MustCompile("^" + p + "$") }

func str(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func decode[T any](body map[string]any) (T, error) {
	var out T
	b, _ := json.Marshal(body)
	err := json.Unmarshal(b, &out)
	return out, err
}

// Start begins serving. It returns once the socket is listening.
func Start(o Options) (*Server, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", o.Port))
	if err != nil {
		return nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	c := o.Core

	var indexHTML []byte
	if o.UI != nil {
		raw, err := fs.ReadFile(o.UI, "index.html")
		if err != nil {
			return nil, fmt.Errorf("the UI is missing index.html: %w", err)
		}
		indexHTML = bytes.Replace(raw, []byte("</head>"), []byte(`<meta name="proxy-app-token" content="`+o.Token+`"></head>`), 1)
	}

	routes := []route{
		{"GET", rx(`/api/state`), func(*http.Request, []string, map[string]any) (any, error) { return c.State(), nil }},
		{"GET", rx(`/api/activity`), func(*http.Request, []string, map[string]any) (any, error) { return c.Activity(), nil }},
		{"DELETE", rx(`/api/activity`), func(*http.Request, []string, map[string]any) (any, error) { c.ClearActivity(); return ok(), nil }},
		{"POST", rx(`/api/connect`), func(*http.Request, []string, map[string]any) (any, error) { return c.Connect() }},
		{"POST", rx(`/api/disconnect`), func(*http.Request, []string, map[string]any) (any, error) { return c.Disconnect() }},
		{"POST", rx(`/api/proxies`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			in, err := decode[types.AddProxiesInput](b)
			if err != nil {
				return nil, errBadBody
			}
			return c.AddProxies(in)
		}},
		{"POST", rx(`/api/proxies/test`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			in, err := decode[types.TestProxyInput](b)
			if err != nil {
				return nil, errBadBody
			}
			return c.TestProxy(in), nil
		}},
		{"POST", rx(`/api/exits`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			in, err := decode[types.CreateExitsInput](b)
			if err != nil {
				return nil, errBadBody
			}
			return c.CreateExits(in)
		}},
		{"POST", rx(`/api/exits/check-all`), func(*http.Request, []string, map[string]any) (any, error) {
			st := c.State()
			ids := make([]string, len(st.Exits))
			for i, e := range st.Exits {
				ids[i] = e.ID
			}
			go c.CheckMany(ids, false)
			return st, nil
		}},
		{"POST", rx(`/api/exits/reorder`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			var ids []string
			if list, ok := b["ids"].([]any); ok {
				for _, v := range list {
					if s, ok := v.(string); ok {
						ids = append(ids, s)
					}
				}
			}
			return c.ReorderExits(ids), nil
		}},
		{"PATCH", rx(`/api/exits/([\w-]+)`), func(_ *http.Request, p []string, b map[string]any) (any, error) { return c.UpdateExit(p[0], b) }},
		{"DELETE", rx(`/api/exits/([\w-]+)`), func(_ *http.Request, p []string, _ map[string]any) (any, error) { return c.DeleteExit(p[0]) }},
		{"GET", rx(`/api/exits/([\w-]+)/url`), func(_ *http.Request, p []string, _ map[string]any) (any, error) {
			u, err := c.ExitURL(p[0])
			if err != nil {
				return nil, err
			}
			return map[string]string{"url": u}, nil
		}},
		{"POST", rx(`/api/exits/([\w-]+)/activate`), func(_ *http.Request, p []string, _ map[string]any) (any, error) { return c.ActivateExit(p[0]) }},
		{"POST", rx(`/api/exits/([\w-]+)/rotate`), func(_ *http.Request, p []string, _ map[string]any) (any, error) { return c.RotateExit(p[0]) }},
		{"POST", rx(`/api/exits/([\w-]+)/check`), func(_ *http.Request, p []string, _ map[string]any) (any, error) { return c.CheckExit(p[0], false) }},
		{"PATCH", rx(`/api/accounts/([\w-]+)`), func(_ *http.Request, p []string, b map[string]any) (any, error) { return c.UpdateAccount(p[0], b) }},
		{"DELETE", rx(`/api/accounts/([\w-]+)`), func(_ *http.Request, p []string, _ map[string]any) (any, error) { return c.DeleteAccount(p[0]) }},
		{"PATCH", rx(`/api/settings`), func(_ *http.Request, _ []string, b map[string]any) (any, error) { return c.UpdateSettings(b) }},
		{"POST", rx(`/api/usage/reset`), func(*http.Request, []string, map[string]any) (any, error) { return c.ResetUsage(), nil }},
		{"GET", rx(`/api/browsers`), func(*http.Request, []string, map[string]any) (any, error) { return c.BrowserProfilesLive(), nil }},
		{"POST", rx(`/api/browsers/open`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			browser := str(b, "browser")
			url := fmt.Sprintf("http://127.0.0.1:%d/browser-setup?b=%s", port, browser)
			if err := c.OpenBrowserProfile(browser, str(b, "dir"), url); err != nil {
				return nil, err
			}
			return ok(), nil
		}},
		{"POST", rx(`/api/extension/reveal`), func(*http.Request, []string, map[string]any) (any, error) {
			if err := c.RevealExtension(); err != nil {
				return nil, err
			}
			return ok(), nil
		}},
		{"POST", rx(`/api/browsers/firefox`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			enabled, _ := b["enabled"].(bool)
			return c.SetFirefoxProxy(str(b, "dir"), enabled)
		}},
		{"POST", rx(`/api/browsers/proxy`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			enabled, _ := b["enabled"].(bool)
			return c.SetBrowserProfileProxy(str(b, "browser"), str(b, "dir"), enabled, str(b, "exitId"))
		}},
		{"GET", rx(`/api/apps`), func(r *http.Request, _ []string, _ map[string]any) (any, error) {
			_, refresh := r.URL.Query()["refresh"]
			return c.ListApps(refresh), nil
		}},
		{"POST", rx(`/api/apps/proxy`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			enabled, _ := b["enabled"].(bool)
			return c.SetAppProxy(str(b, "id"), enabled, str(b, "exitId"))
		}},
		{"POST", rx(`/api/apps/open`), func(_ *http.Request, _ []string, b map[string]any) (any, error) { return c.OpenApp(str(b, "id")) }},
		{"POST", rx(`/api/terminal`), func(_ *http.Request, _ []string, b map[string]any) (any, error) {
			return c.OpenTerminal(str(b, "exitId")), nil
		}},
		{"POST", rx(`/api/shell/(show|hide|quit|updateCheck|updateInstall|updatePage)`), func(_ *http.Request, p []string, _ map[string]any) (any, error) {
			if o.Shell == nil {
				return nil, &core.APIError{Status: 404, Msg: "Only in the desktop app"}
			}
			switch p[0] {
			case "show":
				o.Shell.Show()
			case "hide":
				o.Shell.Hide()
			case "quit":
				go o.Shell.Quit()
			case "updateCheck":
				o.Shell.UpdateCheck()
			case "updateInstall":
				o.Shell.UpdateInstall()
			case "updatePage":
				o.Shell.UpdatePage()
			}
			return ok(), nil
		}},
	}

	hostOK := map[string]bool{fmt.Sprintf("127.0.0.1:%d", port): true, fmt.Sprintf("localhost:%d", port): true}

	mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostOK[strings.ToLower(r.Host)] {
			http.Error(w, "Misdirected request", http.StatusMisdirectedRequest)
			return
		}
		p := r.URL.Path

		if strings.HasPrefix(p, "/api/") {
			given := r.Header.Get("X-Proxy-App-Token")
			if given == "" {
				given = r.URL.Query().Get("token")
			}
			if !secure.SafeEqual(given, o.Token) {
				writeJSON(w, 401, map[string]string{"error": "Not authorized. Reload the app."})
				return
			}
			switch {
			case p == "/api/events" && r.Method == "GET":
				events(w, r, c)
				return
			case p == "/api/apps/icon" && r.Method == "GET":
				png, err := c.AppIcon(r.URL.Query().Get("id"))
				if err != nil || len(png) == 0 {
					w.WriteHeader(404)
					return
				}
				w.Header().Set("Content-Type", "image/png")
				w.Header().Set("Cache-Control", "private, max-age=86400")
				_, _ = w.Write(png)
				return
			}
			for _, rt := range routes {
				if rt.method != r.Method {
					continue
				}
				m := rt.pattern.FindStringSubmatch(p)
				if m == nil {
					continue
				}
				body := map[string]any{}
				if r.Method != "GET" && r.Method != "DELETE" {
					raw, err := io.ReadAll(io.LimitReader(r.Body, 1_000_001))
					if err != nil || len(raw) > 1_000_000 {
						writeJSON(w, 413, map[string]string{"error": "Request too large"})
						return
					}
					if t := bytes.TrimSpace(raw); len(t) > 0 {
						if err := json.Unmarshal(t, &body); err != nil {
							writeJSON(w, 400, map[string]string{"error": "That request wasn't valid JSON"})
							return
						}
					}
				}
				res, err := rt.fn(r, m[1:], body)
				if err != nil {
					status := 500
					var ae *core.APIError
					switch {
					case errors.As(err, &ae):
						status = ae.Status
					case errors.Is(err, errBadBody):
						status = 400
					}
					writeJSON(w, status, map[string]string{"error": err.Error()})
					return
				}
				if res == nil {
					res = ok()
				}
				writeJSON(w, 200, res)
				return
			}
			writeJSON(w, 404, map[string]string{"error": "Not found"})
			return
		}

		// Opened inside the browser profile being set up, so the steps are where the user acts.
		if p == "/browser-setup" && r.Method == "GET" {
			nonce := secure.RandomToken(12)
			for k, v := range securityHeaders {
				w.Header().Set(k, v)
			}
			w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-"+nonce+"'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = io.WriteString(w, setupPage(r.URL.Query().Get("b"), c.State().ExtensionDir, nonce, c.State().Platform == "darwin"))
			return
		}

		if o.UI == nil || r.Method != "GET" {
			w.WriteHeader(404)
			return
		}
		serveUI(w, r, o.UI, indexHTML)
	})

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	return &Server{Port: port, URL: fmt.Sprintf("http://127.0.0.1:%d/", port), srv: srv}, nil
}

var errBadBody = errors.New("That request didn't have the expected fields")

func ok() map[string]bool { return map[string]bool{"ok": true} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func serveUI(w http.ResponseWriter, r *http.Request, ui fs.FS, index []byte) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	for k, v := range securityHeaders {
		w.Header().Set(k, v)
	}
	if name != "" && name != "index.html" {
		if f, err := ui.Open(name); err == nil {
			defer f.Close()
			if st, err := f.Stat(); err == nil && !st.IsDir() {
				ct := mime.TypeByExtension(path.Ext(name))
				if ct == "" {
					ct = "application/octet-stream"
				}
				w.Header().Set("Content-Type", ct)
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				_, _ = io.Copy(w, f)
				return
			}
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(index)
}

// events streams state, traffic and activity to the UI.
func events(w http.ResponseWriter, r *http.Request, c *core.Core) {
	fl, okFlush := w.(http.Flusher)
	if !okFlush {
		w.WriteHeader(500)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)

	send := func(event string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		fl.Flush()
	}
	ch, cancel := c.Subscribe()
	defer cancel()
	send("state", c.State())
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		case e := <-ch:
			switch e.Kind {
			case "state":
				send("state", e.State)
			case "stats":
				send("stats", e.Stats)
			case "activity":
				send("activity", e.Activity)
			}
		}
	}
}
