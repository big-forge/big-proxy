// Package parse reads the proxy formats vendors hand out.
package parse

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/big-forge/big-proxy/internal/providers"
	"github.com/big-forge/big-proxy/internal/types"
)

var (
	schemes  = map[string]string{"http": "http", "https": "https", "socks": "socks5", "socks5": "socks5", "socks5h": "socks5"}
	schemeRe = regexp.MustCompile(`(?i)^([a-z0-9]+)://`)
	portRe   = regexp.MustCompile(`^\d{1,5}$`)
)

func isPort(v string) bool {
	if !portRe.MatchString(v) {
		return false
	}
	n, _ := strconv.Atoi(v)
	return n >= 1 && n <= 65535
}

func decode(v string) string {
	s, err := url.PathUnescape(v)
	if err != nil {
		return v
	}
	return s
}

// ParseProxyLine accepts:
//
//	scheme://user:pass@host:port   user:pass@host:port
//	host:port:user:pass            user:pass:host:port   host:port
//
// It returns nil when the line can't be parsed.
func ParseProxyLine(raw string) *types.ParsedProxy {
	line := strings.TrimSpace(raw)
	if line == "" || strings.HasPrefix(line, "#") {
		return nil
	}
	protocol := "http"
	if m := schemeRe.FindStringSubmatch(line); m != nil {
		p, ok := schemes[strings.ToLower(m[1])]
		if !ok {
			return nil
		}
		protocol = p
		line = line[len(m[0]):]
	}
	line = strings.TrimRight(line, "/")

	var host, portText, username, password string
	if at := strings.LastIndex(line, "@"); at != -1 {
		cred := line[:at]
		if ci := strings.Index(cred, ":"); ci == -1 {
			username = decode(cred)
		} else {
			username = decode(cred[:ci])
			password = decode(cred[ci+1:])
		}
		hp := line[at+1:]
		pi := strings.LastIndex(hp, ":")
		if pi == -1 {
			return nil
		}
		host, portText = hp[:pi], hp[pi+1:]
	} else {
		parts := strings.Split(line, ":")
		switch {
		case len(parts) == 2:
			host, portText = parts[0], parts[1]
		case len(parts) >= 4 && isPort(parts[1]):
			host, portText, username = parts[0], parts[1], parts[2]
			password = strings.Join(parts[3:], ":")
		case len(parts) == 4 && isPort(parts[3]):
			username, password, host, portText = parts[0], parts[1], parts[2], parts[3]
		default:
			return nil
		}
	}

	host = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]"))
	if host == "" || !isPort(portText) {
		return nil
	}
	port, _ := strconv.Atoi(portText)
	p := &types.ParsedProxy{ProxyEndpoint: types.ProxyEndpoint{Protocol: protocol, Host: host, Port: port, Username: username, Password: password}}
	if id := providers.Detect(host); id != "" {
		p.Provider = id
		p.Username, p.Country, p.City = providers.ParseLogin(id, username)
	}
	return p
}

// ParseProxyList parses one proxy per line, skipping blanks and # comments.
func ParseProxyList(text string) (parsed []types.ParsedProxy, invalid []string) {
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if p := ParseProxyLine(t); p != nil {
			parsed = append(parsed, *p)
		} else {
			invalid = append(invalid, t)
		}
	}
	return parsed, invalid
}
