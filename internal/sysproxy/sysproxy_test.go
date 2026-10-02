package sysproxy

import (
	"encoding/json"
	"runtime"
	"testing"
)

func TestToWindowsBypass(t *testing.T) {
	got := ToWindowsBypass([]string{"localhost", "127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "localhost"})
	want := "localhost;127.0.0.1;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;169.254.*;<local>"
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
	if g := ToWindowsBypass([]string{"1.2.3.0/24"}); g != "1.2.3.*;<local>" {
		t.Fatal(g)
	}
}

func TestToMacBypass(t *testing.T) {
	cases := map[string]string{
		"169.254.0.0/16": "169.254/16",
		"10.0.0.0/8":     "10/8",
		"192.168.1.0/24": "192.168.1/24",
		"1.2.3.4/32":     "1.2.3.4/32",
		"localhost":      "localhost",
		"*.local":        "*.local",
		"::1":            "::1",
	}
	for in, want := range cases {
		if got := toMacBypass(in); got != want {
			t.Errorf("%s: got %s want %s", in, got, want)
		}
	}
}

func TestWinEncodePS(t *testing.T) {
	if got := winEncodePS("ab"); got != "YQBiAA==" {
		t.Fatal(got)
	}
}

func TestSnapshotJSON(t *testing.T) {
	b, _ := json.Marshal(Snapshot{Platform: "darwin", Data: json.RawMessage(`[1]`)})
	if string(b) != `{"platform":"darwin","data":[1]}` {
		t.Fatal(string(b))
	}
}

func TestRunErrorIsStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	out, err := Run("sh", "-c", "echo hi; echo oops >&2; exit 3")
	if err == nil || err.Error() != "oops" || out != "hi\n" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestForPlatform(t *testing.T) {
	if ForPlatform() == nil {
		t.Skip("unsupported platform")
	}
}
