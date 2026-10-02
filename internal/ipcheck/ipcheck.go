// Package ipcheck finds out which public IP an upstream exits from, and where it is.
// It runs straight through the upstream, not the local gateway, so it works while
// disconnected and never touches other traffic.
package ipcheck

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/big-forge/big-proxy/internal/types"
	"github.com/big-forge/big-proxy/internal/upstream"
)

const timeout = 8 * time.Second

// openTunnel is a hook so tests can avoid the network.
var openTunnel = upstream.OpenTunnel

// Check looks up the exit IP of an upstream.
func Check(up types.ProxyEndpoint) types.ExitCheck {
	at := time.Now().UnixMilli()
	var latency int64
	haveLatency := false

	t0 := time.Now()
	sock, err := openTunnel(&up, "ip-api.com", 80, timeout)
	if err == nil {
		latency = time.Since(t0).Milliseconds()
		haveLatency = true
		var body string
		body, err = httpGet(sock, "ip-api.com", "/json/?fields=status,message,country,countryCode,regionName,city,isp,query")
		if err == nil {
			var info *types.IPInfo
			if info, err = parseIPAPI(body); err == nil {
				return types.ExitCheck{At: at, OK: true, LatencyMs: latency, Info: info}
			}
		}
	}
	// Login or connection problems won't get better with a second lookup service.
	var ue *upstream.Error
	if errors.As(err, &ue) && ue.Code != "target" && ue.Code != "protocol" {
		return types.ExitCheck{At: at, Error: ue.Msg, ErrorCode: ue.Code}
	}

	info, lat, err := lookupWho(&up, t0)
	if err != nil {
		code := "lookup"
		msg := err.Error()
		if errors.As(err, &ue) {
			code, msg = ue.Code, ue.Msg
		}
		if msg == "" {
			msg = "IP lookup failed"
		}
		return types.ExitCheck{At: at, Error: msg, ErrorCode: code}
	}
	if !haveLatency {
		latency = lat
	}
	return types.ExitCheck{At: at, OK: true, LatencyMs: latency, Info: info}
}

func lookupWho(up *types.ProxyEndpoint, _ time.Time) (*types.IPInfo, int64, error) {
	t0 := time.Now()
	raw, err := openTunnel(up, "ipwho.is", 443, timeout)
	if err != nil {
		return nil, 0, err
	}
	lat := time.Since(t0).Milliseconds()
	_ = raw.SetDeadline(time.Now().Add(timeout))
	conn := tls.Client(raw, &tls.Config{ServerName: "ipwho.is"})
	if err := conn.Handshake(); err != nil {
		raw.Close()
		return nil, 0, err
	}
	body, err := httpGet(conn, "ipwho.is", "/?fields=success,message,ip,country,country_code,region,city,connection")
	if err != nil {
		return nil, 0, err
	}
	info, err := parseIPWho(body)
	return info, lat, err
}

func parseIPAPI(body string) (*types.IPInfo, error) {
	var j struct {
		Status      string `json:"status"`
		Message     string `json:"message"`
		Query       string `json:"query"`
		CountryCode string `json:"countryCode"`
		Country     string `json:"country"`
		RegionName  string `json:"regionName"`
		City        string `json:"city"`
		ISP         string `json:"isp"`
	}
	if err := json.Unmarshal([]byte(body), &j); err != nil {
		return nil, err
	}
	if j.Status != "success" || j.Query == "" {
		return nil, lookupErr(j.Message)
	}
	return clean(types.IPInfo{IP: j.Query, CountryCode: j.CountryCode, Country: j.Country, Region: j.RegionName, City: j.City, ISP: j.ISP}), nil
}

func parseIPWho(body string) (*types.IPInfo, error) {
	var j struct {
		Success     *bool  `json:"success"`
		Message     string `json:"message"`
		IP          string `json:"ip"`
		CountryCode string `json:"country_code"`
		Country     string `json:"country"`
		Region      string `json:"region"`
		City        string `json:"city"`
		Connection  struct {
			ISP string `json:"isp"`
			Org string `json:"org"`
		} `json:"connection"`
	}
	if err := json.Unmarshal([]byte(body), &j); err != nil {
		return nil, err
	}
	if (j.Success != nil && !*j.Success) || j.IP == "" {
		return nil, lookupErr(j.Message)
	}
	isp := j.Connection.ISP
	if isp == "" {
		isp = j.Connection.Org
	}
	return clean(types.IPInfo{IP: j.IP, CountryCode: j.CountryCode, Country: j.Country, Region: j.Region, City: j.City, ISP: isp}), nil
}

func lookupErr(msg string) error {
	if msg == "" {
		msg = "IP lookup failed"
	}
	return errors.New(msg)
}

func clean(i types.IPInfo) *types.IPInfo {
	out := &types.IPInfo{
		IP:          i.IP,
		CountryCode: strings.ToUpper(strings.TrimSpace(i.CountryCode)),
		Country:     strings.TrimSpace(i.Country),
		Region:      strings.TrimSpace(i.Region),
		City:        strings.TrimSpace(i.City),
		ISP:         strings.TrimSpace(i.ISP),
	}
	return out
}

// httpGet sends a hand-written HTTP/1.0 GET and returns the body of a 200 response.
func httpGet(c net.Conn, host, path string) (string, error) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(timeout))
	req := fmt.Sprintf("GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: ProxyApp/1\r\nAccept: application/json\r\nConnection: close\r\n\r\n", path, host)
	if _, err := io.WriteString(c, req); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(c, 1<<20))
	if err != nil && len(data) == 0 {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return "", fmt.Errorf("%s took too long to answer", host)
		}
		return "", err
	}
	text := string(data)
	split := strings.Index(text, "\r\n\r\n")
	status := 0
	if f := strings.Fields(text); len(f) > 1 {
		status, _ = strconv.Atoi(f[1])
	}
	if split == -1 || status != 200 {
		s := "unknown"
		if status != 0 {
			s = strconv.Itoa(status)
		}
		return "", fmt.Errorf("%s answered with status %s", host, s)
	}
	return text[split+4:], nil
}
