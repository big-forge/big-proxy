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
| Windows 10 / 11 | `Proxy-App-Setup-….exe` |

> The app isn't signed yet. If you downloaded it by hand, your computer will warn you once.
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

The app tells you when a new version is out. On Windows it updates itself; on Mac it opens the download page. You can also check in **Settings → Version**.

## Your data

Your proxy logins are saved only on your computer and are never sent anywhere except to your proxy provider.

## For developers

Needs Node.js 20 or newer.

```sh
git clone https://github.com/big-forge/big-proxy
cd big-proxy
npm install
npm run app        # build and open the desktop app
npm test
```

To release a new version, change `version` in `package.json`, commit, then run `git tag v0.2.0 && git push --tags`. GitHub builds and publishes the installers.

MIT licence.
