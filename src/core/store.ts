import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AppRule, Exit, Settings } from '../shared/types';

export interface ConfigFile {
  version: 1;
  accounts: Account[];
  exits: Exit[];
  activeExitId: string | null;
  settings: Settings;
  usage: { up: number; down: number; since: number };
  appRules: Record<string, AppRule>;
}

export const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

export const DEFAULT_SETTINGS: Settings = {
  gatewayPort: 8899,
  allowLan: false,
  lanAuth: { enabled: false, username: 'proxy', password: '' },
  systemProxy: false,
  dropOnSwitch: true,
  autoRotateMinutes: 0,
  bypass: DEFAULT_BYPASS,
  startConnected: false,
  launchAtLogin: false,
  theme: 'system',
};

/** Same folder for the desktop app and the CLI, so both see one config. */
export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Proxy App');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Proxy App');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Proxy App');
}

function fresh(): ConfigFile {
  return {
    version: 1,
    accounts: [],
    exits: [],
    activeExitId: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    usage: { up: 0, down: 0, since: Date.now() },
    appRules: {},
  };
}

/**
 * config.json holds proxy logins in plain text, readable only by this user
 * (mode 600). It never leaves the machine.
 */
export class Store {
  readonly file: string;
  data: ConfigFile;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = this.load();
  }

  private load(): ConfigFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return fresh();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConfigFile>;
      const base = fresh();
      return {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...parsed.settings, lanAuth: { ...base.settings.lanAuth, ...parsed.settings?.lanAuth } },
        usage: { ...base.usage, ...parsed.usage },
        version: 1,
      };
    } catch {
      // Keep the unreadable file for the user instead of silently overwriting it.
      fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      return fresh();
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // A full disk or a deleted folder must not take the proxy down with it.
      console.error(`Couldn't save ${this.file}:`, err instanceof Error ? err.message : err);
    }
  }

  readJson<T>(name: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  writeJson(name: string, value: unknown) {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(value), { mode: 0o600 });
  }

  remove(name: string) {
    fs.rmSync(path.join(this.dir, name), { force: true });
  }
}
