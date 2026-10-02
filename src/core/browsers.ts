import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserId, BrowserProfile } from '../shared/types';
import type { ScannedApp } from './apps';

// Chrome-family browsers share one process for all profiles, so a per-profile
// proxy can only come from an extension installed in that profile. This file
// finds the profiles, tells whether our extension is in each, and opens one.

interface BrowserDef {
  id: BrowserId;
  name: string;
  /** User data folder per platform, relative to the matching base. */
  data: { darwin: string; win32: string; linux: string };
  /** macOS app bundle, Windows exe (relative to Program Files / LocalAppData), Linux command. */
  app: { darwin: string; win32: string; linux: string };
  /** Executable inside the macOS bundle. */
  macExe: string;
}

const BROWSERS: (BrowserDef & { id: Exclude<BrowserId, 'firefox'> })[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    data: { darwin: 'Google/Chrome', win32: 'Google\\Chrome\\User Data', linux: 'google-chrome' },
    app: { darwin: 'Google Chrome.app', win32: 'Google\\Chrome\\Application\\chrome.exe', linux: 'google-chrome' },
    macExe: 'Google Chrome',
  },
  {
    id: 'edge',
    name: 'Edge',
    data: { darwin: 'Microsoft Edge', win32: 'Microsoft\\Edge\\User Data', linux: 'microsoft-edge' },
    app: { darwin: 'Microsoft Edge.app', win32: 'Microsoft\\Edge\\Application\\msedge.exe', linux: 'microsoft-edge' },
    macExe: 'Microsoft Edge',
  },
  {
    id: 'brave',
    name: 'Brave',
    data: { darwin: 'BraveSoftware/Brave-Browser', win32: 'BraveSoftware\\Brave-Browser\\User Data', linux: 'BraveSoftware/Brave-Browser' },
    app: { darwin: 'Brave Browser.app', win32: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', linux: 'brave-browser' },
    macExe: 'Brave Browser',
  },
  {
    id: 'chromium',
    name: 'Chromium',
    data: { darwin: 'Chromium', win32: 'Chromium\\User Data', linux: 'chromium' },
    app: { darwin: 'Chromium.app', win32: 'Chromium\\Application\\chrome.exe', linux: 'chromium' },
    macExe: 'Chromium',
  },
];

type Platform = 'darwin' | 'win32' | 'linux';
const platform = (): Platform => (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux');

function userDataDir(b: BrowserDef): string {
  const home = os.homedir();
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', b.data.darwin);
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), b.data.win32);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), b.data.linux);
  }
}

function findApp(b: BrowserDef): string | null {
  switch (platform()) {
    case 'darwin': {
      const candidates = [path.join('/Applications', b.app.darwin), path.join(os.homedir(), 'Applications', b.app.darwin)];
      return candidates.find((p) => fs.existsSync(p)) ?? null;
    }
    case 'win32': {
      const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
      return roots.map((r) => path.join(r, b.app.win32)).find((p) => fs.existsSync(p)) ?? null;
    }
    default:
      return b.app.linux;
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Chrome records unpacked extensions with their folder in each profile's Secure Preferences. */
function extensionState(profileDir: string, extensionDir: string): BrowserProfile['extension'] {
  const want = path.resolve(extensionDir);
  for (const file of ['Secure Preferences', 'Preferences']) {
    const settings = readJson(path.join(profileDir, file))?.extensions?.settings;
    if (!settings || typeof settings !== 'object') continue;
    for (const ext of Object.values<any>(settings)) {
      if (typeof ext?.path === 'string' && path.resolve(ext.path) === want) {
        return Array.isArray(ext.disable_reasons) ? (ext.disable_reasons.length ? 'disabled' : 'on') : ext.state === 0 ? 'disabled' : 'on';
      }
    }
  }
  return 'missing';
}

export function listProfiles(extensionDir: string): BrowserProfile[] {
  const out: BrowserProfile[] = [];
  for (const b of BROWSERS) {
    const dataDir = userDataDir(b);
    const info = readJson(path.join(dataDir, 'Local State'))?.profile;
    const cache = info?.info_cache;
    if (!cache || typeof cache !== 'object') continue;
    const order: string[] = Array.isArray(info.profiles_order) ? info.profiles_order : Object.keys(cache);
    const dirs = [...new Set([...order, ...Object.keys(cache)])].filter((d) => cache[d] && fs.existsSync(path.join(dataDir, d)));
    for (const dir of dirs) {
      const p = cache[dir];
      out.push({
        browser: b.id,
        browserName: b.name,
        dir,
        name: String(p.name || p.gaia_name || dir),
        email: typeof p.user_name === 'string' && p.user_name ? p.user_name : undefined,
        kind: 'extension',
        extension: extensionState(path.join(dataDir, dir), extensionDir),
        proxyPort: prefsProxyPort(path.join(dataDir, dir)),
        running: false,
      });
    }
  }
  return [...out, ...listFirefoxProfiles()];
}

// ---------- Firefox ----------
// Firefox keeps proxy settings per profile and reads user.js at every start,
// so a managed block there is a real per-profile switch (after a restart).

const BEGIN = '// BEGIN Proxy App (managed by Proxy App, do not edit)';
const END = '// END Proxy App';

export function firefoxRoot(home = os.homedir()): string {
  switch (platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Firefox');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox');
    default:
      return path.join(home, '.mozilla', 'firefox');
  }
}

/** Profiles from profiles.ini. `dir` is the Path entry, which is also how we address the profile. */
export function listFirefoxProfiles(root = firefoxRoot()): BrowserProfile[] {
  let ini: string;
  try {
    ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
  } catch {
    return [];
  }
  const out: BrowserProfile[] = [];
  for (const section of ini.split(/^\[/m).filter((s) => /^Profile\d+\]/.test(s))) {
    const get = (k: string) => section.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    const dir = get('Path');
    if (!dir) continue;
    const folder = firefoxProfileFolder(root, section, dir);
    if (!fs.existsSync(folder)) continue;
    out.push({ browser: 'firefox', browserName: 'Firefox', dir, name: get('Name') ?? dir, kind: 'prefs', extension: firefoxState(folder), proxyPort: null, running: false });
  }
  return out;
}

function firefoxProfileFolder(root: string, section: string, dir: string): string {
  return /^IsRelative=0$/m.test(section) ? dir : path.join(root, dir);
}

function firefoxState(folder: string): BrowserProfile['extension'] {
  try {
    const js = fs.readFileSync(path.join(folder, 'user.js'), 'utf8');
    const block = js.slice(js.indexOf(BEGIN), js.indexOf(END));
    return js.includes(BEGIN) && /"network\.proxy\.type",\s*1\)/.test(block) ? 'on' : 'missing';
  } catch {
    return 'missing';
  }
}

/** Writes (port) or resets (null) our block in the profile's user.js. Firefox applies it on its next start. */
export function setFirefoxProxy(dir: string, port: number | null, root = firefoxRoot()): void {
  const profile = listFirefoxProfiles(root).find((p) => p.dir === dir);
  if (!profile) throw new Error('That Firefox profile was not found');
  const ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
  const section = ini.split(/^\[/m).find((s) => s.match(/^Path=(.*)$/m)?.[1]?.trim() === dir) ?? '';
  const file = path.join(firefoxProfileFolder(root, section, dir), 'user.js');
  let js = '';
  try {
    js = fs.readFileSync(file, 'utf8');
  } catch {
    /* no user.js yet */
  }
  const start = js.indexOf(BEGIN);
  const end = js.indexOf(END);
  if (start !== -1 && end > start) js = js.slice(0, start) + js.slice(end + END.length).replace(/^\r?\n/, '');
  const prefs =
    port === null
      ? // Back to Firefox's default ("use system proxy settings"); prefs.js would otherwise keep ours.
        ['user_pref("network.proxy.type", 5);']
      : [
          'user_pref("network.proxy.type", 1);',
          'user_pref("network.proxy.http", "127.0.0.1");',
          `user_pref("network.proxy.http_port", ${port});`,
          'user_pref("network.proxy.ssl", "127.0.0.1");',
          `user_pref("network.proxy.ssl_port", ${port});`,
          'user_pref("network.proxy.share_proxy_settings", true);',
          'user_pref("network.proxy.no_proxies_on", "localhost, 127.0.0.1, .local");',
          // Keep WebRTC from revealing the real IP.
          'user_pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);',
          'user_pref("media.peerconnection.ice.default_address_only", true);',
        ];
  js = `${js.replace(/\s*$/, '')}${js.trim() ? '\n\n' : ''}${BEGIN}\n${prefs.join('\n')}\n${END}\n`;
  fs.writeFileSync(file, js);
}

/** Opens a window in that profile. If the browser is running, it just adds the window. */
export function openProfile(browser: BrowserId, dir: string, url: string): void {
  const b = BROWSERS.find((x) => x.id === browser);
  if (!b) throw new Error('Unknown browser');
  const app = findApp(b);
  if (!app) throw new Error(`Couldn't find ${b.name} on this computer`);
  const args = [`--profile-directory=${dir}`, url];
  const [cmd, argv] = platform() === 'darwin' ? ['open', ['-na', app, '--args', ...args]] : [app, args];
  spawn(cmd, argv, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
}

// ---------- Chrome-family profile prefs ----------
// Each profile keeps a "proxy" pref in its Preferences file. It isn't one of
// the tamper-protected prefs, and Chrome honours it per profile, so writing it
// (while the browser is closed; Chrome rewrites the file while running) switches
// one profile with no extension.

/** Port of our gateway the profile's proxy pref points at, or null. */
export function prefsProxyPort(profileDir: string): number | null {
  const proxy = readJson(path.join(profileDir, 'Preferences'))?.proxy;
  if (proxy?.mode !== 'fixed_servers' || typeof proxy.server !== 'string') return null;
  const m = proxy.server.match(/^(?:https?:\/\/)?127\.0\.0\.1:(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function writeProfileProxy(browser: BrowserId, dir: string, port: number | null): void {
  const b = BROWSERS.find((x) => x.id === browser);
  if (!b) throw new Error('Unknown browser');
  writeProfilePrefs(path.join(userDataDir(b), dir), port, b.name);
}

/** Sets (port) or removes (null) our proxy in one profile folder. The browser must not be running. */
export function writeProfilePrefs(profileDir: string, port: number | null, browserName = 'the browser'): void {
  const file = path.join(profileDir, 'Preferences');
  const prefs = readJson(file);
  if (!prefs || typeof prefs !== 'object') throw new Error(`Couldn't read the ${browserName} settings for this profile`);
  const webrtc = prefs.webrtc && typeof prefs.webrtc === 'object' ? prefs.webrtc : {};
  if (port === null) {
    delete prefs.proxy;
    if (webrtc.ip_handling_policy === 'disable_non_proxied_udp') delete webrtc.ip_handling_policy;
  } else {
    prefs.proxy = { mode: 'fixed_servers', server: `http://127.0.0.1:${port}`, bypass_list: '<local>' };
    // Keep WebRTC from revealing the real IP.
    webrtc.ip_handling_policy = 'disable_non_proxied_udp';
  }
  prefs.webrtc = webrtc;
  const tmp = `${file}.proxy-app.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs));
  fs.renameSync(tmp, file);
}

/** The browser as an app we can find, quit and relaunch. */
export function browserApp(browser: BrowserId): ScannedApp | null {
  const b = BROWSERS.find((x) => x.id === browser);
  const app = b && findApp(b);
  if (!b || !app) return null;
  const exe = platform() === 'darwin' ? path.join(app, 'Contents', 'MacOS', b.macExe) : app;
  return { id: b.id, name: b.name, path: app, exe, engine: 'chromium', method: 'launch' };
}

/** Shows a folder in Finder / Explorer / the file manager. */
export function revealFolder(dir: string): void {
  const [cmd, args] = platform() === 'darwin' ? ['open', [dir]] : platform() === 'win32' ? ['explorer.exe', [dir]] : ['xdg-open', [dir]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
