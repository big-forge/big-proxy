package sysproxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// GNOME and most GTK desktops read these keys. Other desktops: set the proxy by hand.
var gnomeKeys = [][2]string{
	{"org.gnome.system.proxy", "mode"},
	{"org.gnome.system.proxy", "ignore-hosts"},
	{"org.gnome.system.proxy.http", "host"},
	{"org.gnome.system.proxy.http", "port"},
	{"org.gnome.system.proxy.https", "host"},
	{"org.gnome.system.proxy.https", "port"},
	{"org.gnome.system.proxy.socks", "host"},
	{"org.gnome.system.proxy.socks", "port"},
}

type linuxDriver struct{}

func gset(schema, key, value string) error {
	_, err := Run("gsettings", "set", schema, key, value)
	return err
}

func (linuxDriver) Apply(host string, port int, bypass []string) (Snapshot, error) {
	snap := map[string]string{}
	for _, k := range gnomeKeys {
		out, err := Run("gsettings", "get", k[0], k[1])
		if err != nil {
			return Snapshot{}, errors.New("Automatic proxy setup needs GNOME settings (gsettings). Set the proxy by hand in your desktop settings.")
		}
		snap[k[0]+" "+k[1]] = strings.TrimSpace(out)
	}
	for _, kind := range []string{"http", "https", "socks"} {
		schema := "org.gnome.system.proxy." + kind
		if err := gset(schema, "host", fmt.Sprintf("'%s'", host)); err != nil {
			return Snapshot{}, err
		}
		if err := gset(schema, "port", strconv.Itoa(port)); err != nil {
			return Snapshot{}, err
		}
	}
	items := make([]string, len(bypass))
	for i, b := range bypass {
		items[i] = "'" + b + "'"
	}
	if err := gset("org.gnome.system.proxy", "ignore-hosts", "["+strings.Join(items, ", ")+"]"); err != nil {
		return Snapshot{}, err
	}
	if err := gset("org.gnome.system.proxy", "mode", "'manual'"); err != nil {
		return Snapshot{}, err
	}
	data, _ := json.Marshal(snap)
	return Snapshot{Platform: "linux", Data: data}, nil
}

func (linuxDriver) Restore(s Snapshot) error {
	snap := map[string]string{}
	if err := json.Unmarshal(s.Data, &snap); err != nil {
		return err
	}
	for _, k := range gnomeKeys {
		if v, ok := snap[k[0]+" "+k[1]]; ok {
			gset(k[0], k[1], v)
		}
	}
	return nil
}
