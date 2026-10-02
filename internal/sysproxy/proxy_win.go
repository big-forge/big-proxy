package sysproxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

const winKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

var winValues = []string{"ProxyEnable", "ProxyServer", "ProxyOverride", "AutoConfigURL"}

type windowsDriver struct{}

func winQuery(name string) *string {
	out, err := Run("reg", "query", winKey, "/v", name)
	if err != nil {
		return nil
	}
	m := regexp.MustCompile(name + `\s+REG_\w+\s*(.*)`).FindStringSubmatch(out)
	if m == nil {
		return nil
	}
	v := strings.TrimSpace(m[1])
	return &v
}

func winWrite(name string, value *string) error {
	switch {
	case value == nil:
		Run("reg", "delete", winKey, "/v", name, "/f")
		return nil
	case name == "ProxyEnable":
		v := *value
		base := 10
		if strings.HasPrefix(v, "0x") {
			base, v = 16, v[2:]
		}
		n, _ := strconv.ParseInt(v, base, 64)
		_, err := Run("reg", "add", winKey, "/v", name, "/t", "REG_DWORD", "/d", strconv.FormatInt(n, 10), "/f")
		return err
	}
	_, err := Run("reg", "add", winKey, "/v", name, "/t", "REG_SZ", "/d", *value, "/f")
	return err
}

func winEncodePS(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 0, len(u)*2)
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// winRefresh tells WinINet (and so Edge, Chrome and most apps) to re-read the settings now.
func winRefresh() {
	script := strings.Join([]string{
		`$sig = '[DllImport("wininet.dll")] public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);'`,
		`$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace ProxyApp -PassThru`,
		`[void]$t::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0)`,
		`[void]$t::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0)`,
	}, "; ")
	Run("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", winEncodePS(script))
}

// ToWindowsBypass converts a bypass list to WinINet syntax: wildcards, not CIDR.
func ToWindowsBypass(list []string) string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, entry := range list {
		m := cidrRe.FindStringSubmatch(entry)
		if m == nil {
			if entry != "::1" {
				add(entry)
			}
			continue
		}
		a, b, c := m[1], m[2], m[3]
		bits, _ := strconv.Atoi(m[5])
		switch {
		case bits == 12 && a == "172":
			for i := 16; i < 32; i++ {
				add(fmt.Sprintf("172.%d.*", i))
			}
		case bits <= 8:
			add(a + ".*")
		case bits <= 16:
			add(a + "." + b + ".*")
		default:
			add(a + "." + b + "." + c + ".*")
		}
	}
	add("<local>")
	return strings.Join(out, ";")
}

func (windowsDriver) Apply(host string, port int, bypass []string) (Snapshot, error) {
	snap := map[string]*string{}
	for _, n := range winValues {
		snap[n] = winQuery(n)
	}
	server, override, one := fmt.Sprintf("%s:%d", host, port), ToWindowsBypass(bypass), "1"
	for _, w := range []struct {
		n string
		v *string
	}{{"ProxyServer", &server}, {"ProxyOverride", &override}, {"ProxyEnable", &one}, {"AutoConfigURL", nil}} {
		if err := winWrite(w.n, w.v); err != nil {
			return Snapshot{}, err
		}
	}
	winRefresh()
	data, _ := json.Marshal(snap)
	return Snapshot{Platform: "win32", Data: data}, nil
}

func (windowsDriver) Restore(s Snapshot) error {
	snap := map[string]*string{}
	if err := json.Unmarshal(s.Data, &snap); err != nil {
		return err
	}
	for _, n := range winValues {
		winWrite(n, snap[n])
	}
	if snap["ProxyEnable"] == nil {
		zero := "0"
		winWrite("ProxyEnable", &zero)
	}
	winRefresh()
	return nil
}
