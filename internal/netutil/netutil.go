// Package netutil holds address helpers shared by the gateway and the engine.
package netutil

import (
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
)

// NormalizeAddress strips the IPv4-mapped IPv6 prefix.
func NormalizeAddress(addr string) string {
	return strings.TrimPrefix(addr, "::ffff:")
}

func parseV4(s string) (netip.Addr, bool) {
	a, err := netip.ParseAddr(s)
	if err != nil || !a.Is4() {
		return netip.Addr{}, false
	}
	return a, true
}

func isV6(s string) bool {
	a, err := netip.ParseAddr(s)
	return err == nil && a.Is6() && a.Zone() == ""
}

func isIP(s string) bool {
	_, ok := parseV4(s)
	return ok || isV6(s)
}

func inV4(a netip.Addr, cidr string) bool {
	return netip.MustParsePrefix(cidr).Contains(a)
}

func IsLoopback(addr string) bool {
	ip := NormalizeAddress(addr)
	if a, ok := parseV4(ip); ok {
		return inV4(a, "127.0.0.0/8")
	}
	return ip == "::1"
}

// IsPrivate: loopback, RFC 1918, link-local, CGNAT and IPv6 ULA/link-local.
func IsPrivate(addr string) bool {
	ip := NormalizeAddress(addr)
	if a, ok := parseV4(ip); ok {
		for _, c := range []string{"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"} {
			if inV4(a, c) {
				return true
			}
		}
		return false
	}
	if isV6(ip) {
		l := strings.ToLower(ip)
		return l == "::1" || strings.HasPrefix(l, "fc") || strings.HasPrefix(l, "fd") || strings.HasPrefix(l, "fe80")
	}
	return false
}

func stripBrackets(host string) string {
	h := strings.ToLower(host)
	h = strings.TrimPrefix(h, "[")
	return strings.TrimSuffix(h, "]")
}

// IsLocalTarget reports targets that must never go out through a residential exit.
func IsLocalTarget(host string) bool {
	h := stripBrackets(host)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") {
		return true
	}
	return isIP(h) && IsPrivate(h)
}

func IsLoopbackTarget(host string) bool {
	h := stripBrackets(host)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	return isIP(h) && IsLoopback(h)
}

func FormatHostPort(host string, port int) string {
	if isV6(host) {
		return "[" + host + "]:" + strconv.Itoa(port)
	}
	return host + ":" + strconv.Itoa(port)
}

// ParseHostPort parses host:port or [v6]:port. defaultPort 0 means none.
func ParseHostPort(value string, defaultPort int) (string, int, bool) {
	var host, portText string
	hasPort := false
	if strings.HasPrefix(value, "[") {
		end := strings.Index(value, "]")
		if end == -1 {
			return "", 0, false
		}
		host = value[1:end]
		portText = strings.TrimPrefix(value[end+1:], ":")
		hasPort = portText != ""
	} else if idx := strings.LastIndex(value, ":"); idx == -1 {
		host = value
	} else {
		host = value[:idx]
		portText = value[idx+1:]
		hasPort = true
	}
	port := defaultPort
	if hasPort {
		n, err := strconv.Atoi(portText)
		if err != nil || strings.HasPrefix(portText, "+") {
			return "", 0, false
		}
		port = n
	}
	if host == "" || port < 1 || port > 65535 {
		return "", 0, false
	}
	return host, port, true
}

// LanAddresses lists IPv4 addresses other devices can use to reach this machine.
func LanAddresses() []string {
	var out []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipn.IP.To4()
			if v4 == nil {
				continue
			}
			s := v4.String()
			if IsPrivate(s) && !strings.HasPrefix(s, "169.254.") && !v4.IsLoopback() {
				out = append(out, s)
			}
		}
	}
	rank := func(ip string) int {
		switch {
		case strings.HasPrefix(ip, "192.168."):
			return 0
		case strings.HasPrefix(ip, "10."):
			return 1
		case strings.HasPrefix(ip, "172."):
			return 2
		}
		return 3
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}
