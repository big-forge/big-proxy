package secure

import (
	"regexp"
	"testing"
)

func TestSafeEqual(t *testing.T) {
	if !SafeEqual("abc", "abc") || SafeEqual("abc", "abd") || SafeEqual("abc", "ab") {
		t.Fatal("SafeEqual wrong")
	}
}

func TestIDs(t *testing.T) {
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(SessionID()) {
		t.Fatal("session id")
	}
	if !regexp.MustCompile(`^exit_[0-9a-f]{10}$`).MatchString(NewID("exit")) {
		t.Fatal("new id")
	}
	if len(RandomToken(0)) != 32 || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(RandomToken(5)) {
		t.Fatal("token")
	}
	if RandomToken(24) == RandomToken(24) {
		t.Fatal("not random")
	}
}
