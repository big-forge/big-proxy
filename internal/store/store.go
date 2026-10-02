// Package store persists config.json (proxy logins in plain text, mode 0600, never
// leaves the machine) plus small side files.
//
// Locking: callers lock Store.Mu themselves around reads/writes of Store.Data.
// Save and Flush take Mu internally, so callers must NOT hold Mu when calling them.
package store

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
)

// ConfigFile is the on-disk shape (identical to the Node app's).
type ConfigFile struct {
	Version      int                      `json:"version"`
	Accounts     []types.Account          `json:"accounts"`
	Exits        []types.Exit             `json:"exits"`
	ActiveExitID *string                  `json:"activeExitId"`
	Settings     types.Settings           `json:"settings"`
	Usage        types.Usage              `json:"usage"`
	AppRules     map[string]types.AppRule `json:"appRules"`
}

// DefaultBypass lists the hosts that never go through the proxy.
var DefaultBypass = []string{"localhost", "127.0.0.1", "::1", "*.local", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"}

// DefaultSettings returns a fresh copy of the default settings.
func DefaultSettings() types.Settings {
	return types.Settings{
		GatewayPort:  8899,
		LanAuth:      types.LanAuth{Username: "proxy"},
		DropOnSwitch: true,
		Bypass:       append([]string{}, DefaultBypass...),
		Theme:        "system",
	}
}

// DefaultDataDir is the same folder the Node app used.
func DefaultDataDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Proxy App")
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Proxy App")
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "Proxy App")
}

func fresh() *ConfigFile {
	return &ConfigFile{
		Version:  1,
		Accounts: []types.Account{},
		Exits:    []types.Exit{},
		Settings: DefaultSettings(),
		Usage:    types.Usage{Since: time.Now().UnixMilli()},
		AppRules: map[string]types.AppRule{},
	}
}

// Store owns config.json.
type Store struct {
	Dir  string
	File string
	Data *ConfigFile
	Mu   sync.Mutex

	tmu   sync.Mutex // timer
	timer *time.Timer
	wmu   sync.Mutex // file writes
}

// New creates the directory and loads (or initialises) the config.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{Dir: dir, File: filepath.Join(dir, "config.json")}
	s.Data = s.load()
	return s, nil
}

func (s *Store) load() *ConfigFile {
	raw, err := os.ReadFile(s.File)
	if err != nil {
		return fresh()
	}
	c := fresh()
	if err := json.Unmarshal(raw, c); err != nil {
		// Keep the unreadable file for the user instead of silently overwriting it.
		_ = os.Rename(s.File, fmt.Sprintf("%s.broken-%d", s.File, time.Now().UnixMilli()))
		return fresh()
	}
	c.Version = 1
	if c.Accounts == nil {
		c.Accounts = []types.Account{}
	}
	if c.Exits == nil {
		c.Exits = []types.Exit{}
	}
	if c.AppRules == nil {
		c.AppRules = map[string]types.AppRule{}
	}
	if c.Settings.Bypass == nil {
		c.Settings.Bypass = append([]string{}, DefaultBypass...)
	}
	if c.Usage.Since == 0 {
		c.Usage.Since = time.Now().UnixMilli()
	}
	return c
}

// Save schedules a write in 300ms (coalescing repeated calls). Do not hold Mu.
func (s *Store) Save() {
	s.tmu.Lock()
	defer s.tmu.Unlock()
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(300*time.Millisecond, s.Flush)
}

// Flush writes now, atomically. Do not hold Mu.
func (s *Store) Flush() {
	s.tmu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.tmu.Unlock()

	s.Mu.Lock()
	b, err := json.MarshalIndent(s.Data, "", "  ")
	s.Mu.Unlock()
	if err == nil {
		err = s.writeAtomic(s.File, b)
	}
	if err != nil {
		// A full disk or a deleted folder must not take the proxy down with it.
		log.Printf("Couldn't save %s: %v", s.File, err)
	}
}

func (s *Store) writeAtomic(path string, b []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, path)
}

// ReadJSON decodes a side file into v; false if missing or unreadable.
func (s *Store) ReadJSON(name string, v any) bool {
	b, err := os.ReadFile(filepath.Join(s.Dir, name))
	if err != nil {
		return false
	}
	return json.Unmarshal(b, v) == nil
}

// WriteJSON writes a side file with mode 0600.
func (s *Store) WriteJSON(name string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	path := filepath.Join(s.Dir, name)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// Remove deletes a side file, ignoring absence.
func (s *Store) Remove(name string) { _ = os.Remove(filepath.Join(s.Dir, name)) }
