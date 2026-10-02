package sysproxy

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

var macKinds = []string{"web", "secureweb", "socksfirewall"}

type proxyValue struct {
	Enabled bool   `json:"enabled"`
	Server  string `json:"server"`
	Port    int    `json:"port"`
}

type serviceSnapshot struct {
	Service string                `json:"service"`
	Proxies map[string]proxyValue `json:"proxies"`
	Bypass  []string              `json:"bypass"`
}

type darwinDriver struct{}

func macServices() ([]string, error) {
	out, err := Run("networksetup", "-listallnetworkservices")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(out, "\n")
	var list []string
	if len(lines) > 0 {
		lines = lines[1:]
	}
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l != "" && !strings.HasPrefix(l, "*") {
			list = append(list, l)
		}
	}
	return list, nil
}

func macGetProxy(service, kind string) (proxyValue, error) {
	out, err := Run("networksetup", "-get"+kind+"proxy", service)
	if err != nil {
		return proxyValue{}, err
	}
	field := func(name string) string {
		m := regexp.MustCompile(`(?m)^` + name + `: ?(.*)$`).FindStringSubmatch(out)
		if m == nil {
			return ""
		}
		return strings.TrimSpace(m[1])
	}
	port, _ := strconv.Atoi(field("Port"))
	return proxyValue{Enabled: field("Enabled") == "Yes", Server: field("Server"), Port: port}, nil
}

func macGetBypass(service string) ([]string, error) {
	out, err := Run("networksetup", "-getproxybypassdomains", service)
	if err != nil {
		return nil, err
	}
	if regexp.MustCompile(`(?i)There aren't any`).MatchString(out) {
		return []string{}, nil
	}
	list := []string{}
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			list = append(list, l)
		}
	}
	return list, nil
}

var cidrRe = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)\.(\d+)/(\d+)$`)

// toMacBypass turns a CIDR into macOS's `169.254/16` style; other entries pass through.
func toMacBypass(entry string) string {
	m := cidrRe.FindStringSubmatch(entry)
	if m == nil {
		return entry
	}
	bits, _ := strconv.Atoi(m[5])
	octets := (bits + 7) / 8
	if octets < 1 {
		octets = 1
	}
	if octets > 4 {
		octets = 4
	}
	return strings.Join(m[1:1+octets], ".") + "/" + m[5]
}

func snapshotService(service string) (serviceSnapshot, error) {
	s := serviceSnapshot{Service: service, Proxies: map[string]proxyValue{}}
	for _, k := range macKinds {
		v, err := macGetProxy(service, k)
		if err != nil {
			return s, err
		}
		s.Proxies[k] = v
	}
	b, err := macGetBypass(service)
	if err != nil {
		return s, err
	}
	s.Bypass = b
	return s, nil
}

func (darwinDriver) Apply(host string, port int, bypass []string) (Snapshot, error) {
	list, err := macServices()
	if err != nil {
		return Snapshot{}, fmt.Errorf("Couldn't change the macOS proxy settings: %w", err)
	}
	snaps := make([]*serviceSnapshot, len(list))
	var wg sync.WaitGroup
	for i, svc := range list {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, err := snapshotService(svc); err == nil {
				snaps[i] = &s
			}
		}()
	}
	wg.Wait()
	var ok []serviceSnapshot
	for _, s := range snaps {
		if s != nil {
			ok = append(ok, *s)
		}
	}
	errs := make([]error, len(ok))
	macBypass := make([]string, 0, len(bypass))
	for _, b := range bypass {
		macBypass = append(macBypass, toMacBypass(b))
	}
	for i, s := range ok {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, k := range macKinds {
				if _, err := Run("networksetup", "-set"+k+"proxy", s.Service, host, strconv.Itoa(port)); err != nil {
					errs[i] = err
					return
				}
			}
			args := append([]string{"-setproxybypassdomains", s.Service}, macBypass...)
			if _, err := Run("networksetup", args...); err != nil {
				errs[i] = err
			}
		}()
	}
	wg.Wait()
	failed := 0
	var first error
	for _, e := range errs {
		if e != nil {
			failed++
			if first == nil {
				first = e
			}
		}
	}
	if len(ok) == 0 || failed == len(ok) {
		msg := "Couldn't change the macOS proxy settings"
		if first != nil {
			msg += ": " + first.Error()
		}
		return Snapshot{}, fmt.Errorf("%s", msg)
	}
	data, _ := json.Marshal(ok)
	return Snapshot{Platform: "darwin", Data: data}, nil
}

func (darwinDriver) Restore(snap Snapshot) error {
	var snaps []serviceSnapshot
	if err := json.Unmarshal(snap.Data, &snaps); err != nil {
		return err
	}
	var wg sync.WaitGroup
	for _, s := range snaps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, k := range macKinds {
				prev := s.Proxies[k]
				if prev.Enabled && prev.Server != "" {
					Run("networksetup", "-set"+k+"proxy", s.Service, prev.Server, strconv.Itoa(prev.Port))
				} else {
					Run("networksetup", "-set"+k+"proxystate", s.Service, "off")
				}
			}
			bypass := s.Bypass
			if len(bypass) == 0 {
				bypass = []string{"Empty"}
			}
			Run("networksetup", append([]string{"-setproxybypassdomains", s.Service}, bypass...)...)
		}()
	}
	wg.Wait()
	return nil
}
