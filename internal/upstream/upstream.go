// Package upstream opens tunnels through HTTP, HTTPS and SOCKS5 proxies and
// implements the inbound SOCKS5 handshake.
package upstream

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/big-forge/big-proxy/internal/netutil"
	"github.com/big-forge/big-proxy/internal/types"
)

// Error is a classified upstream failure. Code is one of
// auth|unreachable|timeout|refused|protocol|target.
type Error struct {
	Code   string
	Msg    string
	Status int
}

func (e *Error) Error() string { return e.Msg }

func newErr(code, msg string) *Error { return &Error{Code: code, Msg: msg} }

const defaultTimeout = 15 * time.Second

// bufConn serves bytes the handshake over-read before touching the socket.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (c *bufConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

func wrap(c net.Conn, r *bufio.Reader) net.Conn {
	if r.Buffered() == 0 {
		return c
	}
	return &bufConn{Conn: c, r: r}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout() && !errors.Is(err, syscall.ETIMEDOUT)
}

func timeoutErr(up *types.ProxyEndpoint, host string) *Error {
	if up != nil {
		return newErr("timeout", "The proxy took too long to respond")
	}
	return newErr("timeout", host+" took too long to respond")
}

func dial(ctx context.Context, up *types.ProxyEndpoint, host string, port int, what string) (net.Conn, error) {
	var d net.Dialer
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	var c net.Conn
	var err error
	if up != nil && up.Protocol == "https" {
		td := tls.Dialer{NetDialer: &d, Config: &tls.Config{MinVersion: tls.VersionTLS12}}
		if !isIP(host) {
			td.Config.ServerName = host
		}
		c, err = td.DialContext(ctx, "tcp", addr)
	} else {
		c, err = d.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, socketError(err, what)
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	return c, nil
}

func isIP(h string) bool { _, err := netip.ParseAddr(h); return err == nil }

func socketError(err error, what string) *Error {
	var dns *net.DNSError
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return newErr("refused", fmt.Sprintf("Couldn't connect to %s (connection refused)", what))
	case errors.As(err, &dns):
		if dns.IsTimeout {
			return newErr("timeout", "The proxy took too long to respond")
		}
		return newErr("unreachable", fmt.Sprintf("Couldn't find %s. Check the address and your internet connection.", what))
	case errors.Is(err, syscall.ETIMEDOUT):
		return newErr("timeout", fmt.Sprintf("Couldn't reach %s (timed out)", what))
	case isTimeout(err) || errors.Is(err, context.DeadlineExceeded):
		return newErr("timeout", "The proxy took too long to respond")
	case errors.Is(err, syscall.ECONNRESET):
		return newErr("unreachable", capitalize(what)+" closed the connection")
	}
	return newErr("unreachable", fmt.Sprintf("Couldn't connect to %s: %v", what, err))
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// OpenTunnel opens a raw TCP tunnel to host:port through up (HTTP CONNECT,
// SOCKS5 or https), or directly when up is nil. The returned conn carries no
// handshake bytes.
func OpenTunnel(up *types.ProxyEndpoint, host string, port int, timeout time.Duration) (net.Conn, error) {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	deadline := time.Now().Add(timeout)

	var c net.Conn
	var err error
	if up == nil {
		c, err = dial(ctx, nil, host, port, netutil.FormatHostPort(host, port))
		if err != nil {
			return nil, retimeout(err, up, host)
		}
		return c, nil
	}
	c, err = dial(ctx, up, up.Host, up.Port, "the proxy at "+netutil.FormatHostPort(up.Host, up.Port))
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(deadline)
	var out net.Conn
	if up.Protocol == "socks5" {
		out, err = socks5Connect(c, up, host, port)
	} else {
		out, err = httpConnect(c, up, host, port)
	}
	if err != nil {
		c.Close()
		return nil, retimeout(err, up, host)
	}
	_ = c.SetDeadline(time.Time{})
	return out, nil
}

// retimeout rewrites any timeout into the standard "took too long" message.
func retimeout(err error, up *types.ProxyEndpoint, host string) error {
	var ue *Error
	if errors.As(err, &ue) && ue.Code == "timeout" && up == nil {
		return timeoutErr(nil, host)
	}
	return err
}

// ConnectProxy connects to the proxy server itself without asking for a tunnel.
func ConnectProxy(up *types.ProxyEndpoint, timeout time.Duration) (net.Conn, error) {
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return dial(ctx, up, up.Host, up.Port, "the proxy at "+netutil.FormatHostPort(up.Host, up.Port))
}

// BasicAuth returns "Basic base64(user:pass)" or "" when both are empty.
func BasicAuth(username, password string) string {
	if username == "" && password == "" {
		return ""
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}

// handshakeErr maps an I/O failure during a handshake.
func handshakeErr(err error, closedMsg string) error {
	var ue *Error
	if errors.As(err, &ue) {
		return err
	}
	if isTimeout(err) {
		return newErr("timeout", "The proxy took too long to respond")
	}
	return newErr("protocol", closedMsg)
}

func httpConnect(c net.Conn, up *types.ProxyEndpoint, host string, port int) (net.Conn, error) {
	target := netutil.FormatHostPort(host, port)
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if a := BasicAuth(up.Username, up.Password); a != "" {
		b.WriteString("Proxy-Authorization: " + a + "\r\n")
	}
	b.WriteString("Proxy-Connection: Keep-Alive\r\n\r\n")
	if _, err := io.WriteString(c, b.String()); err != nil {
		return nil, handshakeErr(err, "The proxy closed the connection without answering")
	}
	br := bufio.NewReader(c)
	head, err := ReadHead(br, 16*1024)
	if err != nil {
		return nil, handshakeErr(err, "The proxy closed the connection without answering")
	}
	status := ParseStatus(string(head))
	if status >= 200 && status < 300 {
		return wrap(c, br), nil
	}
	return nil, HTTPStatusError(status, target)
}

// ReadHead reads up to and including "\r\n\r\n", failing past max bytes.
func ReadHead(r *bufio.Reader, max int) ([]byte, error) {
	var buf []byte
	for {
		line, err := r.ReadSlice('\n')
		buf = append(buf, line...)
		if bytes.HasSuffix(buf, []byte("\r\n\r\n")) {
			return buf, nil
		}
		if len(buf) > max {
			return nil, errors.New("head too large")
		}
		if err != nil && !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// ParseStatus returns the status code of an HTTP response head, or 0 when invalid.
func ParseStatus(head string) int {
	parts := strings.SplitN(head, " ", 3)
	if len(parts) < 2 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0
	}
	return n
}

// HTTPStatusError classifies a non-2xx answer from an HTTP proxy. A status of
// 0 or below means the answer was not HTTP at all.
func HTTPStatusError(status int, target string) *Error {
	switch {
	case status == 407:
		return &Error{Code: "auth", Msg: "The proxy rejected the login. Check the username and password.", Status: status}
	case status == 403:
		return &Error{Code: "target", Msg: "The proxy blocked " + target, Status: status}
	case status == 502 || status == 503 || status == 504:
		return &Error{Code: "target", Msg: fmt.Sprintf("The proxy couldn't reach %s (%d)", target, status), Status: status}
	case status <= 0:
		return newErr("protocol", "The proxy didn't answer like an HTTP proxy")
	}
	return &Error{Code: "protocol", Msg: fmt.Sprintf("The proxy answered with status %d", status), Status: status}
}

var socksReplyErrors = map[byte]string{
	1: "general failure", 2: "not allowed by ruleset", 3: "network unreachable", 4: "host unreachable",
	5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported",
}

func socks5Connect(c net.Conn, up *types.ProxyEndpoint, host string, port int) (net.Conn, error) {
	br := bufio.NewReader(c)
	const closed = "The proxy closed the connection during the SOCKS5 handshake"
	fail := func(err error) (net.Conn, error) { return nil, handshakeErr(err, closed) }

	wantsAuth := up.Username != "" || up.Password != ""
	hello := []byte{5, 1, 0}
	if wantsAuth {
		hello = []byte{5, 2, 0, 2}
	}
	if _, err := c.Write(hello); err != nil {
		return fail(err)
	}
	var two [2]byte
	if _, err := io.ReadFull(br, two[:]); err != nil {
		return fail(err)
	}
	if two[0] != 5 {
		return nil, newErr("protocol", "The proxy didn't answer like a SOCKS5 proxy")
	}
	switch two[1] {
	case 0x02:
		u, p := []byte(up.Username), []byte(up.Password)
		if len(u) > 255 || len(p) > 255 {
			return nil, newErr("protocol", "Proxy login is too long for SOCKS5")
		}
		msg := append([]byte{1, byte(len(u))}, u...)
		msg = append(msg, byte(len(p)))
		msg = append(msg, p...)
		if _, err := c.Write(msg); err != nil {
			return fail(err)
		}
		if _, err := io.ReadFull(br, two[:]); err != nil {
			return fail(err)
		}
		if two[1] != 0 {
			return nil, newErr("auth", "The proxy rejected the login. Check the username and password.")
		}
	case 0xff:
		return nil, newErr("auth", "The proxy needs a username and password")
	case 0x00:
	default:
		return nil, newErr("protocol", "The proxy asked for an unsupported login method")
	}

	addr, err := encodeSocksAddress(host)
	if err != nil {
		return nil, err
	}
	req := append([]byte{5, 1, 0}, addr...)
	req = append(req, byte(port>>8), byte(port))
	if _, err := c.Write(req); err != nil {
		return fail(err)
	}
	var h [4]byte
	if _, err := io.ReadFull(br, h[:]); err != nil {
		return fail(err)
	}
	if h[1] != 0 {
		why, ok := socksReplyErrors[h[1]]
		if !ok {
			why = fmt.Sprintf("error %d", h[1])
		}
		return nil, newErr("target", fmt.Sprintf("The proxy couldn't reach %s (%s)", netutil.FormatHostPort(host, port), why))
	}
	var skip int
	switch h[3] {
	case 1:
		skip = 4
	case 4:
		skip = 16
	case 3:
		l, err := br.ReadByte()
		if err != nil {
			return fail(err)
		}
		skip = int(l)
	default:
		return nil, newErr("protocol", "The proxy sent a malformed SOCKS5 reply")
	}
	if _, err := io.CopyN(io.Discard, br, int64(skip+2)); err != nil {
		return fail(err)
	}
	return wrap(c, br), nil
}

func encodeSocksAddress(host string) ([]byte, error) {
	if a, err := netip.ParseAddr(host); err == nil && a.Zone() == "" {
		if a.Is4() {
			b := a.As4()
			return append([]byte{1}, b[:]...), nil
		}
		b := a.As16()
		return append([]byte{4}, b[:]...), nil
	}
	if len(host) > 255 {
		return nil, newErr("protocol", "Host name is too long for SOCKS5")
	}
	return append([]byte{3, byte(len(host))}, host...), nil
}
