package upstream

import (
	"bufio"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
)

// SocksAuth is the login required of inbound SOCKS5 clients.
type SocksAuth struct{ Username, Password string }

// SocksAuthError is returned when a SOCKS5 client fails the login handshake.
type SocksAuthError struct{ Msg string }

func (e *SocksAuthError) Error() string { return e.Msg }

func safeEqual(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func contains(b []byte, v byte) bool {
	for _, x := range b {
		if x == v {
			return true
		}
	}
	return false
}

func readCredentials(r *bufio.Reader) (string, string, error) {
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return "", "", err
	}
	u := make([]byte, h[1])
	if _, err := io.ReadFull(r, u); err != nil {
		return "", "", err
	}
	pl, err := r.ReadByte()
	if err != nil {
		return "", "", err
	}
	p := make([]byte, pl)
	if _, err := io.ReadFull(r, p); err != nil {
		return "", "", err
	}
	return string(u), string(p), nil
}

// AcceptSocks5 is the server side of a SOCKS5 handshake; the version byte has
// already been consumed. Only CONNECT is supported.
func AcceptSocks5(c net.Conn, r *bufio.Reader, auth *SocksAuth) (string, int, error) {
	n, err := r.ReadByte()
	if err != nil {
		return "", 0, err
	}
	methods := make([]byte, n)
	if _, err := io.ReadFull(r, methods); err != nil {
		return "", 0, err
	}
	switch {
	case auth != nil:
		if !contains(methods, 0x02) {
			c.Write([]byte{5, 0xff})
			return "", 0, &SocksAuthError{"Client did not offer a login"}
		}
		c.Write([]byte{5, 0x02})
		u, p, err := readCredentials(r)
		if err != nil {
			return "", 0, err
		}
		ok := safeEqual(u, auth.Username) && safeEqual(p, auth.Password)
		if ok {
			c.Write([]byte{1, 0})
		} else {
			c.Write([]byte{1, 1})
			return "", 0, &SocksAuthError{"Wrong gateway login"}
		}
	case contains(methods, 0x00):
		c.Write([]byte{5, 0x00})
	case contains(methods, 0x02):
		// Some clients always send a login; none is required, so accept any.
		c.Write([]byte{5, 0x02})
		if _, _, err := readCredentials(r); err != nil {
			return "", 0, err
		}
		c.Write([]byte{1, 0})
	default:
		c.Write([]byte{5, 0xff})
		return "", 0, &SocksAuthError{"No supported login method"}
	}

	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return "", 0, err
	}
	if h[0] != 5 {
		return "", 0, errors.New("Bad SOCKS5 request")
	}
	var host string
	switch h[3] {
	case 1:
		var b [4]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", 0, err
		}
		host = fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
	case 3:
		l, err := r.ReadByte()
		if err != nil {
			return "", 0, err
		}
		b := make([]byte, l)
		if _, err := io.ReadFull(r, b); err != nil {
			return "", 0, err
		}
		host = string(b)
	case 4:
		var b [16]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", 0, err
		}
		host = netip.AddrFrom16(b).String()
	default:
		SocksReply(c, 8)
		return "", 0, errors.New("Unsupported SOCKS5 address type")
	}
	var pb [2]byte
	if _, err := io.ReadFull(r, pb[:]); err != nil {
		return "", 0, err
	}
	port := int(pb[0])<<8 | int(pb[1])
	if h[1] != 1 {
		SocksReply(c, 7)
		return "", 0, errors.New("Only SOCKS5 CONNECT is supported")
	}
	return host, port, nil
}

// SocksReply writes a SOCKS5 reply with the given code and a zero bind address.
func SocksReply(c net.Conn, rep byte) {
	c.Write([]byte{5, rep, 0, 1, 0, 0, 0, 0, 0, 0})
}

// SocksReplyFor maps an error to a SOCKS5 reply code.
func SocksReplyFor(err error) byte {
	var ue *Error
	if !errors.As(err, &ue) {
		return 1
	}
	switch ue.Code {
	case "refused":
		return 5
	case "unreachable", "target", "timeout":
		return 4
	case "auth":
		return 2
	}
	return 1
}
