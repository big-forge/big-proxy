// Package secure holds the small crypto helpers: constant-time compare and random ids.
package secure

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
)

func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("secure: crypto/rand failed: " + err.Error())
	}
	return b
}

// SafeEqual compares two strings in constant time (for equal lengths).
func SafeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// RandomToken returns n random bytes as base64url without padding (24 if n <= 0).
func RandomToken(nBytes int) string {
	if nBytes <= 0 {
		nBytes = 24
	}
	return base64.RawURLEncoding.EncodeToString(randBytes(nBytes))
}

// SessionID is a short, URL- and login-safe id for sticky sessions (12 hex chars).
func SessionID() string { return hex.EncodeToString(randBytes(6)) }

// NewID returns prefix + "_" + 10 hex chars.
func NewID(prefix string) string { return prefix + "_" + hex.EncodeToString(randBytes(5)) }
