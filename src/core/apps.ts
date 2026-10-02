import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppEngine, AppMethod } from '../shared/types';

// Per-app proxying without a kernel/network extension: Chromium-based apps
// (Electron, CEF, Chromium browsers) accept --proxy-server at launch, so we
// restart them with it. Apps with their own proxy setting get instructions.
// Everything else only follows the system proxy.

export interface ScannedApp {
  id: string;
  name: string;
  /** .app bundle on macOS, .exe on Windows. */
  path: string;
  /** The process to look for and launch. */
  exe: string;
  engine: AppEngine;
  method: AppMethod;
  hint?: string;
  icon?: string;
}

export interface RunningApp {
  pid: number;
  command: string;
}

const run = (cmd: string, args: string[], timeout = 15_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/** Apps whose traffic is best proxied from their own settings. Matched on bundle id or name. */
const INSIDE: { match: RegExp; hint: string }[] = [
  { match: /telegram/i, hint: 'Settings → Data and Storage (or Advanced) → Proxy → add SOCKS5, server 127.0.0.1, port {port}.' },
  { match: /spotify/i, hint: 'Settings → Proxy settings → HTTP, host 127.0.0.1, port {port}.' },
  { match: /anydesk/i, hint: 'Settings → Connection → Proxy → use an HTTP proxy, 127.0.0.1 port {port}.' },
  { match: /jetbrains|android\.studio|intellij|pycharm|webstorm|goland|phpstorm|rider|clion|datagrip/i, hint: 'Settings → Appearance & Behavior → System Settings → HTTP Proxy → Manual, 127.0.0.1 port {port}.' },
  { match: /adspower|multilogin|gologin|dolphin|incogniton|octo ?browser|morelogin|kameleo|undetectable/i, hint: 'Add the proxy in each browser profile: HTTP or SOCKS5, 127.0.0.1, port {port} (or an IP’s fixed port).' },
  { match: /qbittorrent|transmission|utorrent|deluge/i, hint: 'Preferences → Connection → Proxy → SOCKS5, 127.0.0.1 port {port}.' },
  { match: /docker/i, hint: 'Settings → Resources → Proxies → manual, http://127.0.0.1:{port} for both.' },
  { match: /postman|insomnia/i, hint: 'Settings → Proxy → custom proxy, 127.0.0.1 port {port}. Requests you send then go through it.' },
];

/** Chrome-family browsers are handled per profile with the extension. */
const PROFILE_BROWSERS = /^(com\.google\.chrome|com\.microsoft\.edgemac|com\.brave\.browser|org\.chromium\.chromium|org\.mozilla\.firefox)$|\\(chrome|msedge|brave|firefox)\.exe$/i;
const SELF = /app\.proxyapp\.desktop|\\proxy app\.exe$/i;

function classify(id: string, name: string, engine: AppEngine): { method: AppMethod; hint?: string } {
  const inside = INSIDE.find((r) => r.match.test(id) || r.match.test(name));
  if (inside) return { method: 'inside', hint: inside.hint };
  if (engine !== 'native') return { method: 'launch' };
  return { method: 'system' };
}

// ---------- macOS ----------

async function readPlist(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', file]));
  } catch {
    return null;
  }
}

function macEngine(bundle: string): AppEngine {
  const fw = path.join(bundle, 'Contents', 'Frameworks');
  let names: string[] = [];
  try {
    names = fs.readdirSync(fw);
  } catch {
    return 'native';
  }
  if (names.includes('Electron Framework.framework')) return 'electron';
  if (names.includes('Chromium Embedded Framework.framework')) return 'cef';
  if (names.some((n) => /(Chrome|Chromium|Edge|Brave Browser|Opera|Vivaldi|Arc|Yandex) Framework\.framework$/i.test(n))) return 'chromium';
  return 'native';
}

async function scanMac(): Promise<ScannedApp[]> {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications'];
  const bundles: string[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith('.app')) bundles.push(path.join(dir, e));
      // One level into folders like /Applications/Utilities or vendor folders.
      else if (!e.startsWith('.') && dir !== '/System/Applications') {
        try {
          for (const sub of fs.readdirSync(path.join(dir, e))) if (sub.endsWith('.app')) bundles.push(path.join(dir, e, sub));
        } catch {
          /* not a folder */
        }
      }
    }
  }
  const out: ScannedApp[] = [];
  const queue = [...bundles];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const info = await readPlist(path.join(b, 'Contents', 'Info.plist'));
      const exeName = typeof info?.CFBundleExecutable === 'string' ? info.CFBundleExecutable : null;
      if (!info || !exeName) continue;
      const id = typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : b;
      if (PROFILE_BROWSERS.test(id) || SELF.test(id) || info.LSUIElement === true || info.LSUIElement === '1') continue;
      const name = String(info.CFBundleDisplayName || info.CFBundleName || path.basename(b, '.app'));
      const engine = macEngine(b);
      const iconName = typeof info.CFBundleIconFile === 'string' ? info.CFBundleIconFile : 'AppIcon';
      const icon = path.join(b, 'Contents', 'Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`);
      out.push({ id, name, path: b, exe: path.join(b, 'Contents', 'MacOS', exeName), engine, ...classify(id, name, engine), icon: fs.existsSync(icon) ? icon : undefined });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return dedupe(out);
}

// ---------- Windows ----------

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function winEngine(exe: string): AppEngine {
  const dir = path.dirname(exe);
  const has = (p: string) => fs.existsSync(path.join(dir, p));
  if (has('resources\\app.asar') || has('resources\\app') || has('resources\\electron.asar')) return 'electron';
  if (has('libcef.dll')) return 'cef';
  if (/\\(opera|vivaldi|yandex|chromium)\.exe$/i.test(exe) || has('chrome_100_percent.pak')) return 'chromium';
  return 'native';
}

/** Squirrel installers (Slack, Discord…) keep the real exe in the newest app-x.y.z folder. */
function squirrelExe(root: string, name: string): string | null {
  try {
    const versions = fs.readdirSync(root).filter((d) => /^app-\d/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const latest = versions.at(-1);
    if (!latest) return null;
    const exes = fs.readdirSync(path.join(root, latest)).filter((f) => f.toLowerCase().endsWith('.exe') && !/squirrel|update/i.test(f));
    const best = exes.find((f) => f.toLowerCase().startsWith(name.toLowerCase().split(' ')[0])) ?? exes[0];
    return best ? path.join(root, latest, best) : null;
  } catch {
    return null;
  }
}

async function scanWindows(): Promise<ScannedApp[]> {
  const out: ScannedApp[] = [];
  for (const key of UNINSTALL_KEYS) {
    let text = '';
    try {
      text = await run('reg', ['query', key, '/s']);
    } catch {
      continue;
    }
    for (const block of text.split(/\r?\n\r?\n/)) {
      const val = (n: string) => block.match(new RegExp(`^\\s+${n}\\s+REG_\\w+\\s+(.+)$`, 'm'))?.[1]?.trim();
      const name = val('DisplayName');
      if (!name || val('SystemComponent') === '0x1' || /update|redistributable|runtime|driver|sdk/i.test(name)) continue;
      const icon = val('DisplayIcon')?.replace(/^"|"?,-?\d+$|"$/g, '');
      const location = val('InstallLocation')?.replace(/^"|"$/g, '');
      let exe = icon?.toLowerCase().endsWith('.exe') && !/uninst|update\.exe/i.test(icon) ? icon : null;
      if (!exe && location) exe = squirrelExe(location, name);
      if (!exe || !fs.existsSync(exe)) continue;
      const id = exe.toLowerCase();
      if (PROFILE_BROWSERS.test(id) || SELF.test(id)) continue;
      const engine = winEngine(exe);
      out.push({ id, name, path: exe, exe, engine, ...classify(id, name, engine), icon: exe });
    }
  }
  return dedupe(out);
}

function dedupe(apps: ScannedApp[]): ScannedApp[] {
  const seen = new Map<string, ScannedApp>();
  for (const a of apps) if (!seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let cache: { at: number; apps: ScannedApp[] } | null = null;

/** Installed apps. Scanning takes about a second, so results are kept for a minute. */
export async function scanApps(force = false): Promise<ScannedApp[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.apps;
  const apps = process.platform === 'darwin' ? await scanMac() : process.platform === 'win32' ? await scanWindows() : [];
  cache = { at: Date.now(), apps };
  return apps;
}

// ---------- processes ----------

export async function listProcesses(): Promise<RunningApp[]> {
  if (process.platform === 'win32') {
    try {
      const json = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
      ]);
      const rows = JSON.parse(json || '[]');
      return (Array.isArray(rows) ? rows : [rows]).map((r: any) => ({ pid: r.ProcessId, command: r.CommandLine || r.ExecutablePath || '' }));
    } catch {
      return [];
    }
  }
  try {
    const out = await run('ps', ['-axww', '-o', 'pid=,command=']);
    return out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ pid: Number(m[1]), command: m[2] }));
  } catch {
    return [];
  }
}

/** The app's main process (not helpers), if it's running. */
export function findMain(app: ScannedApp, procs: RunningApp[]): RunningApp | null {
  const exe = app.exe.toLowerCase();
  return (
    procs.find((p) => {
      const cmd = p.command.toLowerCase().replace(/^"/, '');
      // Electron/Chromium children carry --type=renderer|gpu-process|utility…
      return cmd.startsWith(exe) && !/\s--type=/.test(cmd);
    }) ?? null
  );
}

/** Gateway port a running app was started with, or null when it runs without our proxy. */
export function proxyPortOf(proc: RunningApp | null): number | null {
  const m = proc?.command.match(/--proxy-server=(?:https?:\/\/)?127\.0\.0\.1:(\d+)/);
  return m ? Number(m[1]) : null;
}

export function proxyArgs(port: number): string[] {
  return [`--proxy-server=http://127.0.0.1:${port}`];
}

/** Asks the app to quit (Chromium apps treat SIGTERM / WM_CLOSE as a normal quit) and waits. */
export async function quitApp(app: ScannedApp, timeoutMs = 10_000): Promise<boolean> {
  const main = findMain(app, await listProcesses());
  if (!main) return true;
  try {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(main.pid), '/T']).catch(() => {});
    else process.kill(main.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    if (!findMain(app, await listProcesses())) return true;
  }
  return false;
}

export function launchApp(app: ScannedApp, args: string[]): void {
  const [cmd, argv] = process.platform === 'darwin' ? ['open', ['-a', app.path, ...(args.length ? ['--args', ...args] : [])]] : [app.exe, args];
  // `open` hands our environment to the app; ELECTRON_RUN_AS_NODE would make an Electron app start as bare Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  spawn(cmd, argv, { detached: true, stdio: 'ignore', cwd: path.dirname(app.exe), env }).on('error', () => {}).unref();
}

// ---------- icons ----------

/** 64px PNG for the list. Uses the shell's icon provider when there is one (desktop app). */
export async function appIcon(app: ScannedApp, cacheDir: string, provider?: (file: string) => Promise<Buffer | null>): Promise<Buffer | null> {
  const key = crypto.createHash('sha1').update(app.path).digest('hex').slice(0, 16);
  const file = path.join(cacheDir, `${key}.png`);
  try {
    return fs.readFileSync(file);
  } catch {
    /* not cached yet */
  }
  let png: Buffer | null = null;
  if (provider) png = await provider(app.path).catch(() => null);
  if (!png && process.platform === 'darwin' && app.icon) {
    try {
      await run('sips', ['-s', 'format', 'png', '-Z', '64', app.icon, '--out', file]);
      png = fs.readFileSync(file);
    } catch {
      png = null;
    }
  }
  if (!png && process.platform === 'win32' && app.icon) {
    const ps = `Add-Type -AssemblyName System.Drawing; [System.Drawing.Icon]::ExtractAssociatedIcon('${app.icon.replace(/'/g, "''")}').ToBitmap().Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      png = fs.readFileSync(file);
    } catch {
      png = null;
    }
  }
  if (png) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, png);
  }
  return png;
}

// ---------- terminal ----------

/** Opens a terminal window whose commands and scripts use the gateway. */
export function openProxyTerminal(port: number, dataDir: string): void {
  const http = `http://127.0.0.1:${port}`;
  const socks = `socks5h://127.0.0.1:${port}`;
  if (process.platform === 'darwin') {
    const file = path.join(dataDir, 'proxy-terminal.command');
    fs.writeFileSync(
      file,
      `#!/bin/zsh
export HTTP_PROXY=${http} HTTPS_PROXY=${http} ALL_PROXY=${socks}
export http_proxy=${http} https_proxy=${http} all_proxy=${socks}
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
clear
echo "Proxy App: commands in this window use 127.0.0.1:${port}."
echo "Check with: curl https://api.ipify.org"
exec $SHELL -l
`,
      { mode: 0o700 },
    );
    spawn('open', [file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } else if (process.platform === 'win32') {
    const env = `$env:HTTP_PROXY='${http}'; $env:HTTPS_PROXY='${http}'; $env:ALL_PROXY='${socks}'; $env:NO_PROXY='localhost,127.0.0.1'; Write-Host 'Proxy App: commands in this window use 127.0.0.1:${port}.'`;
    spawn('cmd.exe', ['/c', 'start', 'powershell.exe', '-NoExit', '-Command', env], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', `env HTTP_PROXY=${http} HTTPS_PROXY=${http} ALL_PROXY=${socks} $SHELL`], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
}
