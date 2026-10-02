package desktop

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type instance struct {
	PID int    `json:"pid"`
	URL string `json:"url"`
}

// RunningInstance returns the URL of another Proxy App that is already running with this config, or "".
func RunningInstance(dataDir string) string {
	b, err := os.ReadFile(filepath.Join(dataDir, "instance.json"))
	if err != nil {
		return ""
	}
	var in instance
	if json.Unmarshal(b, &in) != nil || in.URL == "" {
		return ""
	}
	client := http.Client{Timeout: 800 * time.Millisecond}
	resp, err := client.Get(in.URL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if strings.Contains(string(body), "proxy-app-token") {
		return in.URL
	}
	return ""
}

// RegisterInstance records this process so a second launch can find it.
func RegisterInstance(dataDir, url string) func() {
	file := filepath.Join(dataDir, "instance.json")
	b, _ := json.Marshal(instance{PID: os.Getpid(), URL: url})
	_ = os.WriteFile(file, b, 0o600)
	return func() { _ = os.Remove(file) }
}
