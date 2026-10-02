# Proxy App

Use your residential proxies on your computer, in single browser profiles, or on your phone, and switch IPs with one click. Everything runs on your own machine.

## Install

Open a terminal and paste one line.

**Mac**

```sh
curl -fsSL https://raw.githubusercontent.com/big-forge/big-proxy/main/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/big-forge/big-proxy/main/install.ps1 | iex
```

It finds the right version for your computer, installs it, and opens it.

Prefer a normal download? Get the file for your system from the [latest release](https://github.com/big-forge/big-proxy/releases/latest) and open it.

| System | File |
| --- | --- |
| Mac with Apple chip (M1 and newer) | `Proxy-App-…-mac-arm64.dmg` |
| Mac with Intel chip | `Proxy-App-…-mac-x64.dmg` |
| Windows 10 / 11 | `Proxy-App-…-windows-x64.zip` (unzip, open `Proxy App.exe`) |

> The app is small (under 10 MB) and isn't signed yet. If you downloaded it by hand, your computer will warn you once.
> **Mac:** System Settings → Privacy & Security → **Open Anyway**.
> **Windows:** **More info** → **Run anyway**.
> The install commands above skip the Mac warning.

## Use it

1. Open Proxy App and paste your proxy login, for example `login:password@gw.dataimpulse.com:823`.
2. Pick a country and how many IPs you want.
3. Click **Connect**.
4. To switch IP, click another one in the list, or press its number key. **New IP** gets a fresh one.

By default only what you choose uses the proxy. In the **Apps** tab, switch on the browser profiles and apps you want, so the rest of your computer keeps its normal connection and doesn't use proxy data.

## Update

The app updates itself. It checks for a new version in the background, downloads it, and shows **Restart to update**. You can also check in **Settings → Version**.

## Your data

Your proxy logins are saved only on your computer and are never sent anywhere except to your proxy provider.

## For developers

Needs Go 1.24+ and Node.js 20+ (Node is only used to build the UI).

```sh
git clone https://github.com/big-forge/big-proxy
cd big-proxy
npm install
npm run build          # builds the UI, then dist/bin/proxyapp
./dist/bin/proxyapp    # tray app; add --web for just the UI in a browser tab
npm test               # go vet + go test -race
npm run dev            # engine + Vite with hot reload on http://localhost:5173
```

The engine is Go (`internal/`): gateway, providers, system proxy, browser profiles and app routing. The screens are React (`src/ui/`) and the browser extension is plain JavaScript (`extension/`). Both are embedded into the one binary.

To release a new version, commit, then run `git tag v0.3.0 && git push --tags`. GitHub builds the Mac and Windows packages and publishes them; installed copies pick the update up on their own.

MIT licence.
