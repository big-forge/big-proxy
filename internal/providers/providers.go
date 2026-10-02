// Package providers knows how to read and build proxy-provider logins (DataImpulse).
package providers

import (
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/big-forge/big-proxy/internal/types"
)

// LoginOptions is the targeting folded into a provider login.
type LoginOptions struct {
	Country, City string
	// Session is present only for sticky exits.
	Session        string
	SessionMinutes int
}

const dataImpulse = "dataimpulse"

var dataImpulseHost = regexp.MustCompile(`(?i)(^|\.)dataimpulse\.com$`)

// Detect returns the provider id for a host, or "".
func Detect(host string) string {
	if dataImpulseHost.MatchString(host) {
		return dataImpulse
	}
	return ""
}

// Name is the display name of a provider id.
func Name(provider string) string {
	if provider == dataImpulse {
		return "DataImpulse"
	}
	return provider
}

// ParseLogin splits a pasted login into the base login and any targeting inside it.
// DataImpulse: LOGIN__cr.in;city.mumbai;sessid.abc;sessttl.30
func ParseLogin(provider, username string) (base, country, city string) {
	idx := strings.Index(username, "__")
	if idx == -1 {
		return username, "", ""
	}
	base = username[:idx]
	for _, part := range strings.Split(username[idx+2:], ";") {
		dot := strings.Index(part, ".")
		if dot == -1 {
			continue
		}
		key := strings.ToLower(part[:dot])
		value := part[dot+1:]
		if key == "cr" && value != "" {
			// cr can list several countries ("us,gb"); keep the first.
			country = strings.ToLower(strings.Split(value, ",")[0])
		}
		if key == "city" && value != "" {
			city = strings.ToLower(value)
		}
	}
	return base, country, city
}

// BuildLogin folds targeting into the base login.
func BuildLogin(provider, base string, o LoginOptions) string {
	var params []string
	if o.Country != "" {
		params = append(params, "cr."+strings.ToLower(o.Country))
	}
	if o.City != "" {
		params = append(params, "city."+CitySlug(o.City))
	}
	if o.Session != "" {
		params = append(params, "sessid."+o.Session)
		if o.SessionMinutes != 0 {
			params = append(params, fmt.Sprintf("sessttl.%d", int(math.Round(float64(o.SessionMinutes)))))
		}
	}
	if len(params) == 0 {
		return base
	}
	return base + "__" + strings.Join(params, ";")
}

var accents = map[rune]string{
	'à': "a", 'á': "a", 'â': "a", 'ã': "a", 'ä': "a", 'å': "a", 'ā': "a", 'ă': "a", 'ą': "a",
	'ç': "c", 'ć': "c", 'č': "c", 'ĉ': "c", 'ċ': "c",
	'ď': "d", 'đ': "d", 'ð': "d",
	'è': "e", 'é': "e", 'ê': "e", 'ë': "e", 'ē': "e", 'ĕ': "e", 'ė': "e", 'ę': "e", 'ě': "e",
	'ĝ': "g", 'ğ': "g", 'ġ': "g", 'ģ': "g",
	'ĥ': "h", 'ħ': "h",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i", 'ĩ': "i", 'ī': "i", 'ĭ': "i", 'į': "i", 'ı': "i",
	'ĵ': "j", 'ķ': "k",
	'ĺ': "l", 'ļ': "l", 'ľ': "l", 'ł': "l",
	'ñ': "n", 'ń': "n", 'ņ': "n", 'ň': "n",
	'ò': "o", 'ó': "o", 'ô': "o", 'õ': "o", 'ö': "o", 'ø': "o", 'ō': "o", 'ŏ': "o", 'ő': "o",
	'ŕ': "r", 'ŗ': "r", 'ř': "r",
	'ś': "s", 'ŝ': "s", 'ş': "s", 'š': "s", 'ș': "s", 'ß': "ss",
	'ţ': "t", 'ť': "t", 'ț': "t", 'ŧ': "t",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u", 'ũ': "u", 'ū': "u", 'ŭ': "u", 'ů': "u", 'ű': "u", 'ų': "u",
	'ŵ': "w", 'ý': "y", 'ÿ': "y", 'ŷ': "y",
	'ź': "z", 'ż': "z", 'ž': "z",
	'æ': "ae", 'œ': "oe", 'þ': "th",
}

// CitySlug turns "New York" into "newyork", the form DataImpulse expects.
func CitySlug(city string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(city) {
		if s, ok := accents[r]; ok {
			b.WriteString(s)
			continue
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// UpstreamFor is the upstream proxy an exit connects through, or nil if its account is gone.
func UpstreamFor(exit types.Exit, accounts []types.Account) *types.ProxyEndpoint {
	if exit.Kind == "proxy" {
		return exit.Proxy
	}
	for _, a := range accounts {
		if a.ID != exit.AccountID {
			continue
		}
		sticky := exit.Mode == "sticky"
		o := LoginOptions{Country: exit.Country, City: exit.City}
		if sticky {
			o.Session = exit.Session
			o.SessionMinutes = exit.SessionMinutes
		}
		return &types.ProxyEndpoint{
			Protocol: a.Protocol,
			Host:     a.Host,
			Port:     a.Port,
			Username: BuildLogin(a.Provider, a.Username, o),
			Password: a.Password,
		}
	}
	return nil
}
