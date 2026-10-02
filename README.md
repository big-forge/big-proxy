# Proxy App

Route this computer, and phones on your Wi-Fi, through residential proxies. Switch exit IPs with one click.

- **One local gateway.** Apps connect to `127.0.0.1:8899` (HTTP and SOCKS5 on the same port). Switching IPs changes where the gateway sends traffic, so nothing needs to be reconfigured.
- **Instant switching.** Click an IP, press `1`–`9`, or use the menu bar / tray. Open connections are closed so every app moves to the new IP at once.
- **New IP on demand.** Sticky IPs hold for 30 minutes (configurable). "New IP" gets a fresh one; dead residential peers are replaced automatically.
- **Only what you choose.** Put a single Chrome, Edge or Brave profile on the proxy and leave the rest of the computer on your normal connection, so you don't spend proxy data on updates and sync. Or route the whole computer, which sets the system proxy and restores your settings afterwards, even after a crash.
- **One IP per profile.** Every IP also gets a fixed local port (`127.0.0.1:8901`, `8902`, …) that never changes when you switch, so two profiles or apps can hold two IPs at once.
- **Phones too.** Turn on *Devices* and point a phone's Wi-Fi proxy at this computer. It follows your switches. A PAC URL is served for automatic setup.
- **Any provider.** DataImpulse logins get country, city and sticky-session controls. Any other HTTP/HTTPS/SOCKS5 proxy works as-is.
- **Local only.** Logins live in a config file on your machine. Nothing is hosted, nothing phones home.

## Install

Download from the [Releases](../../releases) page:

| System | File |
| --- | --- |
| macOS, Apple Silicon | `Proxy-App-x.y.z-mac-arm64.dmg` |
| macOS, Intel | `Proxy-App-x.y.z-mac-x64.dmg` |
| Windows 10/11 | `Proxy-App-Setup-x.y.z.exe` |

The builds are not code-signed yet, so the first launch needs one extra step:

- **macOS:** open the app once, then go to System Settings → Privacy & Security and click **Open Anyway**. If macOS says the app "is damaged", run `xattr -cr "/Applications/Proxy App.app"` in Terminal and open it again.
- **Windows:** on the SmartScreen prompt click **More info → Run anyway**.

## First run

1. Paste your proxy login, for example `LOGIN:PASSWORD@gw.dataimpulse.com:823`.
2. For DataImpulse, pick a country, sticky or rotating, and how many IPs you want.
3. Click **Connect**. Your traffic now leaves from the IP shown at the top.

Accepted formats, one per line: `user:pass@host:port`, `http://…`, `socks5://…`, `host:port:user:pass`, `user:pass:host:port`, `host:port`.

## Use the proxy in one browser profile

Chrome runs all profiles in one process, so the only per-profile switch is an extension inside that profile. Proxy App ships one.

1. Open the **Apps** tab. It lists your Chrome, Edge and Brave profiles.
2. Click **Set up** next to a profile and follow the four steps: open the profile, go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the folder shown.
3. Click the Proxy App button in that profile's toolbar to choose its IP: *Same as the app* (follows your switching) or a fixed one.

The extension only affects that profile. When Proxy App is off, the profile stops loading pages instead of showing your real IP (you can change this). It also stops WebRTC from leaking your real IP. Firefox profiles have their own proxy setting; point it at `127.0.0.1:8899`.

## Run without installing (web mode)

Needs Node.js 20+.

```sh
npm install
npm run build
npm start          # opens http://127.0.0.1:8898
```

The web UI and the desktop app share the same config file, so use one or the other at a time.

## Develop

```sh
npm install
npm run dev        # core with reload + Vite on http://localhost:5173
npm run app        # build and launch the Electron app
npm test           # gateway + parser tests (no real proxy needed)
npm run typecheck
```

Build installers:

```sh
npm run dist:mac   # .dmg for arm64 and x64, on a Mac
npm run dist:win   # .exe installer, best run on Windows
```

If Electron downloads crawl (GitHub can be slow from India), use a mirror:

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

Pushing a tag like `v0.2.0` runs [.github/workflows/release.yml](.github/workflows/release.yml), which builds both and publishes a GitHub release.

## Updates

The desktop app checks GitHub Releases on launch and every 6 hours, and from Settings → Version → *Check for updates*. The repo must be public for it to see releases.

- **Windows:** downloads in the background; click *Restart to update*.
- **macOS:** shows *Download x.y.z* and opens the release page. Replacing the app by itself needs a Developer ID signature (builds are unsigned for now). Once signed, add a `zip` target under `build.mac.target` and set `PROXY_APP_SIGNED=1` when building.

To ship an update: bump `version` in `package.json`, commit, then `git tag v0.2.0 && git push --tags`.

## How it works

```
your apps ──► 127.0.0.1:8899 (gateway) ──► provider gateway ──► residential exit IP ──► website
phone ─────┘          ▲
                      └── the active IP decides the upstream login for each new connection
```

- `src/core/gateway.ts` is a mixed-protocol proxy server. It sniffs the first byte: `0x05` is SOCKS5, anything else is HTTP (plain requests and `CONNECT`).
- Each exit is an upstream proxy endpoint. For DataImpulse the login carries the targeting: `LOGIN__cr.in;sessid.ab12cd;sessttl.60`. A new `sessid` means a new IP.
- Hostnames are resolved by the provider, so DNS doesn't leak. Local addresses (`192.168.x`, `*.local`, …) always go direct. Devices on the network can never reach this computer's own services through the gateway.
- `src/core/server.ts` is the control API the UI uses. It listens on 127.0.0.1 only, needs a per-launch token, and rejects foreign `Host` headers (DNS rebinding).
- `extension/` is the browser extension (Manifest V3, no build step). It sets the profile's proxy with `chrome.proxy`, which Chrome scopes to one profile, and reads `GET /proxy-app.json` from the gateway (loopback and extension origins only) to show the IP and find fixed ports.
- `src/core/sysproxy/` changes system proxy settings: `networksetup` on macOS, the WinINet registry keys on Windows, `gsettings` on GNOME. A snapshot of the previous settings is written first and restored on disconnect, quit or the next launch.

Config lives in:

- macOS: `~/Library/Application Support/Proxy App/config.json`
- Windows: `%APPDATA%\Proxy App\config.json`
- Linux: `~/.config/Proxy App/config.json`

The file is readable only by your user. It holds your proxy passwords in plain text, so never commit it or send it around.

## Sharing with friends

Each friend installs the app and adds a proxy login. If you share one provider login, you share its traffic balance. Friends on the same Wi-Fi can use your connection from their phones via *Devices*. Friends elsewhere can join over [Tailscale](https://tailscale.com); `100.x` addresses are accepted like local ones.

## Adding a provider

Providers live in `src/core/providers/`. A provider turns a base login plus country, city and session into the provider's login format. Copy `dataimpulse.ts`, change `matches`, `parseLogin` and `buildLogin`, and register it in `index.ts`.

## Licence

MIT
