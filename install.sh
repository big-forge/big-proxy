#!/bin/sh
# Installs the latest Proxy App for this computer.
#   curl -fsSL https://raw.githubusercontent.com/big-forge/big-proxy/main/install.sh | sh
#
# Options (environment): PROXY_APP_VERSION=0.1.0  PROXY_APP_DIR=/Applications  PROXY_APP_NO_LAUNCH=1
set -eu

REPO="big-forge/big-proxy"
DIR="${PROXY_APP_DIR:-/Applications}"

say() { printf '  %s\n' "$*"; }
fail() { printf '\n  Could not install Proxy App: %s\n\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but was not found."; }

need curl

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  MINGW* | MSYS* | CYGWIN*)
    # Git Bash on Windows: hand over to the PowerShell installer.
    say "Windows detected, using the PowerShell installer."
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex"
    ;;
  Darwin) ;;
  Linux)
    fail "there is no Linux desktop build yet. You can run the web version instead:
    git clone https://github.com/$REPO && cd big-proxy && npm install && npm run build && npm start"
    ;;
  *) fail "unsupported system: $os" ;;
esac

case "$arch" in
  arm64 | aarch64) mac_arch="arm64" ;;
  x86_64 | amd64)
    # A Terminal running under Rosetta reports x86_64 on Apple Silicon.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then mac_arch="arm64"; else mac_arch="x64"; fi
    ;;
  *) fail "unsupported processor: $arch" ;;
esac

if [ -n "${PROXY_APP_VERSION:-}" ]; then
  version="${PROXY_APP_VERSION#v}"
else
  say "Finding the latest version..."
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || fail "couldn't read the latest release. Is there a published release at https://github.com/$REPO/releases ?"
fi

file="Proxy-App-$version-mac-$mac_arch.dmg"
url="https://github.com/$REPO/releases/download/v$version/$file"
tmp="$(mktemp -d)"
mnt="$tmp/mount"
cleanup() {
  hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

say "Downloading Proxy App $version for macOS ($mac_arch)..."
curl -fL --progress-bar -o "$tmp/$file" "$url" || fail "download failed: $url"

say "Installing to $DIR..."
mkdir -p "$mnt" "$DIR"
hdiutil attach "$tmp/$file" -nobrowse -quiet -mountpoint "$mnt" || fail "couldn't open the disk image."
app="$mnt/Proxy App.app"
[ -d "$app" ] || fail "the disk image doesn't contain Proxy App.app."

# Quit the running copy so it can be replaced (only when we're replacing an installed one).
if [ -d "$DIR/Proxy App.app" ] && pgrep -x "Proxy App" >/dev/null 2>&1; then
  say "Closing the running Proxy App..."
  osascript -e 'tell application "Proxy App" to quit' >/dev/null 2>&1 || pkill -x "Proxy App" || true
  i=0
  while pgrep -x "Proxy App" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
fi

rm -rf "$DIR/Proxy App.app"
cp -R "$app" "$DIR/Proxy App.app" || fail "couldn't copy the app to $DIR (try: PROXY_APP_DIR=\$HOME/Applications)."
# Not notarized yet; clearing the quarantine flag avoids the "Open Anyway" step.
xattr -cr "$DIR/Proxy App.app" 2>/dev/null || true

say "Installed: $DIR/Proxy App.app"
if [ -z "${PROXY_APP_NO_LAUNCH:-}" ]; then
  open "$DIR/Proxy App.app"
  say "Proxy App is open. Look for its icon in the menu bar."
fi
