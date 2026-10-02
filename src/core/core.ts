import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Account,
  ActivityEntry,
  AddProxiesInput,
  AppState,
  BrowserId,
  BrowserProfile,
  ConnectionStatus,
  CreateExitsInput,
  Exit,
  ExitCheck,
  ExitMode,
  GatewayStatus,
  InstalledApp,
  UpdateState,
  ProviderExit,
  ProxyEndpoint,
  ProxyProtocol,
  Settings,
  TestProxyInput,
  TestProxyResult,
  TrafficStats,
} from '../shared/types';
import { appIcon, findMain, launchApp, listProcesses, openProxyTerminal, proxyArgs, proxyPortOf, quitApp, scanApps } from './apps';
import { browserApp, listProfiles, openProfile, revealFolder, setFirefoxProxy, writeProfileProxy } from './browsers';
import { Gateway, type PinnedPort } from './gateway';
import { checkUpstream } from './ipcheck';
import { lanAddresses } from './net-utils';
import { parseProxyLine, parseProxyList } from './parse';
import { providers, upstreamFor } from './providers';
import { newId, sessionId } from './secure';
import { Store } from './store';
import { systemProxyDriver, type ProxySnapshot } from './sysproxy';
import type { UpstreamError } from './upstream';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CoreOptions {
  dataDir: string;
  shell: 'desktop' | 'web';
  version: string;
  /** Bundled browser extension, copied into the data folder so browsers load it from a stable path. */
  extensionSource?: string;
  /** App icons from the shell (the desktop app asks the OS); falls back to sips / PowerShell. */
  iconProvider?: (file: string) => Promise<Buffer | null>;
}

type CoreEvents = {
  state: [AppState];
  stats: [TrafficStats];
  activity: [ActivityEntry[]];
};

const RESTORE_FILE = 'sysproxy-restore.json';
const ACTIVITY_LIMIT = 500;
const PROTOCOLS: ProxyProtocol[] = ['http', 'https', 'socks5'];
/** Fixed per-exit ports start here, so "India 1" usually lands on 8901. */
const FIRST_PINNED_PORT = 8901;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryName(code: string | undefined): string {
  if (!code) return 'Any country';
  try {
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * Owns everything that isn't UI: saved proxies, which exit is active, the
 * local gateway, and the OS proxy setting. Both shells (desktop and web)
 * drive it through the control API.
 */
export class Core extends EventEmitter<CoreEvents> {
  readonly store: Store;
  readonly extensionDir: string;
  private readonly gateway: Gateway;
  private status: ConnectionStatus = 'off';
  private statusError?: string;
  private sysSnapshot: ProxySnapshot | null = null;
  private systemProxyError?: string;
  private checks = new Map<string, { session: string | null; promise: Promise<ExitCheck> }>();
  private activity = new Map<number, ActivityEntry>();
  private pendingActivity = new Map<number, ActivityEntry>();
  private lan: string[] = [];
  private update?: UpdateState;
  private upstreamError?: { at: number; message: string };
  private upstreamFailures = 0;
  private last = { up: 0, down: 0 };
  private session = { up: 0, down: 0 };
  private ticks = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CoreOptions) {
    super();
    this.store = new Store(opts.dataDir);
    this.extensionDir = path.join(opts.dataDir, 'browser-extension');
    this.gateway = new Gateway({
      route: (exitId) => {
        const exit = exitId ? this.data.exits.find((e) => e.id === exitId) : this.activeExit();
        const upstream = exit && upstreamFor(exit, this.data.accounts);
        return exit && upstream ? { upstream, exitId: exit.id } : null;
      },
      pac: (address) => pacScript(address),
      upstreamResult: (err) => this.onUpstreamResult(err),
      status: () => this.gatewayStatus(),
      control: (action, body) => this.extensionAction(action, body),
    });
    this.gateway.on('activity', (entry) => {
      this.activity.set(entry.id, entry);
      this.pendingActivity.set(entry.id, entry);
      if (this.activity.size > ACTIVITY_LIMIT) {
        const oldest = this.activity.keys().next().value;
        if (oldest !== undefined) this.activity.delete(oldest);
      }
    });
  }

  private get data() {
    return this.store.data;
  }

  private get settings(): Settings {
    return this.store.data.settings;
  }

  async init() {
    await this.recoverSystemProxy();
    this.installExtension();
    if (this.assignPorts(this.data.exits)) this.store.save();
    this.lan = lanAddresses();
    this.statsTimer = setInterval(() => this.tick(), 1000);
    // Listen from the start (refusing traffic) so the browser extension can find us and connect.
    await this.gateway.start(this.gatewayConfig()).catch(() => {});
    if (this.settings.startConnected && this.activeExit()) {
      await this.connect().catch(() => {});
    }
  }

  async shutdown() {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    await this.disconnect().catch(() => {});
    await this.gateway.stop();
    this.store.flush();
  }

  /** What the browser extension may do through the gateway. */
  private async extensionAction(action: string, body: Record<string, unknown>): Promise<unknown> {
    const exitId = typeof body.exitId === 'string' ? body.exitId : null;
    switch (action) {
      case 'connect':
        await this.connect();
        return this.gatewayStatus();
      case 'rotate':
        if (!exitId) throw new ApiError(400, 'Which IP?');
        return this.rotateExit(exitId);
      case 'check':
        if (!exitId) throw new ApiError(400, 'Which IP?');
        return this.checkExit(exitId);
      default:
        throw new ApiError(404, 'Unknown action');
    }
  }

  /** Serialize state-changing operations so connect/disconnect/switch never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  // ---------- state ----------

  getState(): AppState {
    return {
      version: this.opts.version,
      platform: process.platform,
      shell: this.opts.shell,
      dataDir: this.store.dir,
      status: this.status,
      statusError: this.statusError,
      systemProxyActive: this.sysSnapshot !== null,
      systemProxyError: this.systemProxyError,
      activeExitId: this.data.activeExitId,
      accounts: this.data.accounts,
      exits: this.data.exits,
      settings: this.settings,
      checking: [...this.checks.keys()],
      lanAddresses: this.lan,
      usage: this.data.usage,
      upstreamError: this.upstreamError,
      pinnedErrors: this.gateway.pinnedErrors,
      extensionDir: this.extensionDir,
      appRules: this.data.appRules,
      update: this.update,
    };
  }

  /** The desktop shell reports update progress here so the UI can show it. */
  setUpdate(update: UpdateState) {
    this.update = update;
    this.changed();
  }

  private gatewayStatus(): GatewayStatus {
    return {
      app: 'proxy-app',
      version: this.opts.version,
      connected: this.status === 'on',
      port: this.settings.gatewayPort,
      activeExitId: this.data.activeExitId,
      exits: this.data.exits.map((e) => ({
        id: e.id,
        name: e.name,
        port: e.port && !this.gateway.pinnedErrors[e.id] ? e.port : null,
        ip: e.lastCheck?.info?.ip,
        countryCode: e.lastCheck?.info?.countryCode ?? (e.kind === 'provider' ? e.country?.toUpperCase() : undefined),
        city: e.lastCheck?.info?.city,
        latencyMs: e.lastCheck?.ok ? e.lastCheck.latencyMs : undefined,
        mode: e.kind === 'proxy' ? 'proxy' : e.mode,
      })),
    };
  }

  getActivity(): ActivityEntry[] {
    return [...this.activity.values()].reverse();
  }

  clearActivity() {
    this.activity.clear();
    this.pendingActivity.clear();
  }

  private changed() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.emit('state', this.getState());
    }, 30);
  }

  private tick() {
    const totals = this.gateway.totals();
    const up = Math.max(0, totals.up - this.last.up);
    const down = Math.max(0, totals.down - this.last.down);
    this.last = { up: totals.up, down: totals.down };
    if (this.status === 'on') {
      this.session.up += up;
      this.session.down += down;
      if (up || down) {
        this.data.usage.up += up;
        this.data.usage.down += down;
      }
    }
    this.emit('stats', { at: Date.now(), upRate: up, downRate: down, up: this.session.up, down: this.session.down, active: totals.active });

    if (this.pendingActivity.size) {
      this.emit('activity', [...this.pendingActivity.values()]);
      this.pendingActivity.clear();
    }

    this.ticks++;
    // Sticky IPs can change when the provider's session ends; keep the shown IP honest.
    if (this.ticks % 600 === 0 && this.status === 'on' && this.data.activeExitId) void this.checkExit(this.data.activeExitId).catch(() => {});
    if (this.ticks % 15 === 0) {
      // Standby listener couldn't open (port busy at launch)? Keep trying so the extension can find us.
      if (!this.gateway.running && this.status === 'off') void this.gateway.start(this.gatewayConfig()).catch(() => {});
      if (up || down || this.status === 'on') this.store.save();
      const lan = lanAddresses();
      if (lan.join() !== this.lan.join()) {
        this.lan = lan;
        this.changed();
      }
    }
  }

  // ---------- connection ----------

  private activeExit(): Exit | null {
    return this.data.exits.find((e) => e.id === this.data.activeExitId) ?? null;
  }

  connect(): Promise<AppState> {
    return this.exclusive(async () => {
      if (this.status === 'on') return this.getState();
      if (!this.activeExit()) throw new ApiError(400, 'Add a proxy first, then pick which IP to use.');
      this.status = 'connecting';
      this.statusError = undefined;
      this.changed();
      try {
        if (!this.gateway.running) await this.gateway.start(this.gatewayConfig());
      } catch (err) {
        this.status = 'error';
        this.statusError = err instanceof Error ? err.message : String(err);
        this.changed();
        throw new ApiError(409, this.statusError);
      }
      this.gateway.setActive(true);
      this.last = { up: 0, down: 0 };
      this.session = { up: 0, down: 0 };
      this.status = 'on';
      if (this.settings.systemProxy) await this.applySystemProxy();
      this.scheduleRotate();
      this.changed();
      const active = this.data.activeExitId;
      if (active) void this.checkExit(active).catch(() => {});
      return this.getState();
    });
  }

  disconnect(): Promise<AppState> {
    return this.exclusive(async () => {
      if (this.rotateTimer) clearInterval(this.rotateTimer);
      this.rotateTimer = null;
      await this.restoreSystemProxy();
      // Keep listening in standby: traffic is refused, the extension can still reach us.
      this.gateway.setActive(false);
      this.status = 'off';
      this.statusError = undefined;
      this.store.save();
      this.changed();
      return this.getState();
    });
  }

  private gatewayConfig() {
    const s = this.settings;
    const lanAuth = s.allowLan && s.lanAuth.enabled && s.lanAuth.password ? { username: s.lanAuth.username, password: s.lanAuth.password } : null;
    return { port: s.gatewayPort, allowLan: s.allowLan, lanAuth, pinned: this.pinnedPorts() };
  }

  private pinnedPorts(): PinnedPort[] {
    return this.data.exits.filter((e) => e.port).map((e) => ({ exitId: e.id, port: e.port! }));
  }

  /** Re-opens pinned ports after exits were added, removed or renumbered. */
  private async syncPinned() {
    if (this.gateway.running) await this.gateway.syncPinned(this.pinnedPorts());
    this.changed();
  }

  /** Gives every exit without one its own fixed port. Returns true if anything changed. */
  private assignPorts(exits: Exit[]): boolean {
    const taken = new Set([this.settings.gatewayPort, ...this.data.exits.map((e) => e.port).filter(Boolean)]);
    let next = FIRST_PINNED_PORT;
    let changed = false;
    for (const exit of exits) {
      if (exit.port) continue;
      while (taken.has(next)) next++;
      exit.port = next;
      taken.add(next);
      changed = true;
    }
    return changed;
  }

  /** Drops connections using these exits so their apps reconnect with the new IP. */
  private dropExits(ids: string[]) {
    if (this.status !== 'on' || !this.settings.dropOnSwitch) return;
    const set = new Set(ids);
    this.gateway.drop((c) => c.exitId !== null && set.has(c.exitId));
  }

  private async applySystemProxy() {
    if (this.sysSnapshot) return;
    const driver = systemProxyDriver();
    if (!driver) {
      this.systemProxyError = "Automatic setup isn't available on this system. Point your apps at the gateway address instead.";
      return;
    }
    try {
      const snap = await driver.apply('127.0.0.1', this.settings.gatewayPort, this.settings.bypass);
      this.sysSnapshot = snap;
      this.store.writeJson(RESTORE_FILE, snap);
      this.systemProxyError = undefined;
    } catch (err) {
      this.systemProxyError = err instanceof Error ? err.message : String(err);
    }
  }

  private async restoreSystemProxy() {
    const snap = this.sysSnapshot;
    if (!snap) return;
    const driver = systemProxyDriver();
    try {
      await driver?.restore(snap);
      this.sysSnapshot = null;
      this.store.remove(RESTORE_FILE);
    } catch (err) {
      this.systemProxyError = `Couldn't restore your previous proxy settings: ${err instanceof Error ? err.message : err}`;
      this.sysSnapshot = null;
    }
  }

  /** If the app died while connected, the OS still points at a dead gateway. Undo that. */
  private async recoverSystemProxy() {
    const snap = this.store.readJson<ProxySnapshot>(RESTORE_FILE);
    if (!snap) return;
    if (snap.platform === process.platform) await systemProxyDriver()?.restore(snap).catch(() => {});
    this.store.remove(RESTORE_FILE);
  }

  private onUpstreamResult(err: UpstreamError | null) {
    if (!err) {
      this.upstreamFailures = 0;
      if (this.upstreamError) {
        this.upstreamError = undefined;
        this.changed();
      }
      return;
    }
    if (err.code === 'auth' || err.code === 'refused' || err.code === 'unreachable') {
      this.upstreamFailures++;
      if (err.code === 'auth' || this.upstreamFailures >= 3) {
        this.upstreamError = { at: Date.now(), message: err.message };
        this.changed();
      }
    }
  }

  private scheduleRotate() {
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    this.rotateTimer = null;
    const minutes = this.settings.autoRotateMinutes;
    if (this.status !== 'on' || !minutes) return;
    this.rotateTimer = setInterval(() => {
      const exit = this.activeExit();
      if (exit?.kind === 'provider' && exit.mode === 'sticky') void this.rotateExit(exit.id).catch(() => {});
    }, minutes * 60_000);
  }

  // ---------- exits ----------

  private exitOr404(id: string): Exit {
    const exit = this.data.exits.find((e) => e.id === id);
    if (!exit) throw new ApiError(404, 'That IP is no longer in your list');
    return exit;
  }

  /** Moves new connections to another exit. Existing ones are closed when dropOnSwitch is on. */
  activateExit(id: string): Promise<AppState> {
    return this.exclusive(async () => {
      this.exitOr404(id);
      if (this.data.activeExitId !== id) {
        this.data.activeExitId = id;
        this.upstreamError = undefined;
        this.upstreamFailures = 0;
        // Pinned ports keep their own IP; only the main port follows the switch.
        if (this.status === 'on' && this.settings.dropOnSwitch) this.gateway.drop((c) => c.pinned === null);
        this.store.save();
        this.changed();
      }
      void this.checkExit(id).catch(() => {});
      return this.getState();
    });
  }

  /** "New IP": a fresh session id makes the provider hand out a different IP. */
  async rotateExit(id: string): Promise<ExitCheck> {
    const exit = this.exitOr404(id);
    if (exit.kind !== 'provider' || exit.mode !== 'sticky') {
      throw new ApiError(400, exit.kind === 'proxy' ? 'This proxy has a fixed IP.' : 'This exit already changes IP on every connection.');
    }
    exit.session = sessionId();
    exit.sessionStartedAt = Date.now();
    exit.lastCheck = undefined;
    this.dropExits([id]);
    this.store.save();
    this.changed();
    return this.checkExit(id, { heal: true });
  }

  /**
   * Looks up the exit's public IP. With `heal`, a sticky session whose
   * residential peer is dead gets swapped for a fresh one (up to 3 tries),
   * which is what people expect from "New IP" and from newly added exits.
   */
  checkExit(id: string, opts: { heal?: boolean } = {}): Promise<ExitCheck> {
    const exit = this.exitOr404(id);
    if (!upstreamFor(exit, this.data.accounts)) throw new ApiError(400, 'The account for this IP was removed');
    const session = exit.kind === 'provider' ? exit.session : null;
    const running = this.checks.get(id);
    if (running && running.session === session) return running.promise;

    const entry = { session, promise: this.runCheck(id, opts.heal ? 3 : 1) };
    entry.promise = entry.promise.finally(() => {
      if (this.checks.get(id) === entry) this.checks.delete(id);
      this.changed();
    });
    this.checks.set(id, entry);
    this.changed();
    return entry.promise;
  }

  private async runCheck(id: string, attempts: number): Promise<ExitCheck> {
    for (let attempt = 1; ; attempt++) {
      const exit = this.data.exits.find((e) => e.id === id);
      const upstream = exit && upstreamFor(exit, this.data.accounts);
      if (!exit || !upstream) return { at: Date.now(), ok: false, error: 'This IP was removed' };
      const session = exit.kind === 'provider' ? exit.session : null;
      const result = await checkUpstream(upstream);

      const current = this.data.exits.find((e) => e.id === id);
      // Superseded: the session was rotated or the exit deleted while we checked.
      if (!current || (current.kind === 'provider' && current.session !== session)) return result;

      const deadPeer = !result.ok && (result.errorCode === 'target' || result.errorCode === 'timeout' || result.errorCode === 'protocol');
      if (deadPeer && attempt < attempts && current.kind === 'provider' && current.mode === 'sticky') {
        current.session = sessionId();
        current.sessionStartedAt = Date.now();
        // Same in-flight entry, now tracking the new session.
        const entry = this.checks.get(id);
        if (entry) entry.session = current.session;
        continue;
      }

      current.lastCheck = result;
      this.store.save();
      if (id === this.data.activeExitId) {
        if (result.ok) this.onUpstreamResult(null);
        else if (result.errorCode === 'auth') this.upstreamError = { at: Date.now(), message: result.error! };
      }
      return result;
    }
  }

  async checkMany(ids: string[], opts: { heal?: boolean } = {}) {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await this.checkExit(id, opts).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  }

  private makeProviderExits(input: CreateExitsInput, taken = new Set(this.data.exits.map((e) => e.name))): ProviderExit[] {
    const count = Math.min(25, Math.max(1, Math.floor(input.count || 1)));
    const country = input.country?.toLowerCase() || undefined;
    const city = input.city?.trim() || undefined;
    const place = city ? titleCase(city) : countryName(country);
    const exits: ProviderExit[] = [];
    let n = 1;
    for (let i = 0; i < count; i++) {
      let name: string;
      if (input.mode === 'rotating') {
        name = `${place} rotating`;
        for (let k = 2; taken.has(name); k++) name = `${place} rotating ${k}`;
      } else {
        while (taken.has(`${place} ${n}`)) n++;
        name = `${place} ${n}`;
      }
      taken.add(name);
      exits.push({
        kind: 'provider',
        id: newId('exit'),
        name,
        accountId: input.accountId,
        mode: input.mode,
        country,
        city,
        session: sessionId(),
        sessionMinutes: input.mode === 'sticky' ? input.sessionMinutes || undefined : undefined,
        sessionStartedAt: Date.now(),
        createdAt: Date.now(),
      });
    }
    return exits;
  }

  private addExits(created: Exit[]) {
    this.assignPorts(created);
    this.data.exits.push(...created);
    if (!this.activeExit() && created[0]) this.data.activeExitId = created[0].id;
    this.store.save();
    void this.syncPinned();
    void this.checkMany(
      created.map((e) => e.id),
      { heal: true },
    );
  }

  /** Paste box: one proxy per line. Provider logins become an account plus `count` exits. */
  addProxies(input: AddProxiesInput) {
    const { parsed, invalid } = parseProxyList(input.text ?? '');
    if (!parsed.length) {
      throw new ApiError(400, invalid.length ? `Couldn't read "${truncate(invalid[0])}". Use login:password@host:port.` : 'Paste at least one proxy.');
    }
    const created: Exit[] = [];
    const taken = new Set(this.data.exits.map((e) => e.name));
    for (const p of parsed) {
      if (p.provider) {
        let account = this.data.accounts.find(
          (a) => a.provider === p.provider && a.host === p.host && a.port === p.port && a.username === p.username && a.protocol === p.protocol,
        );
        if (!account) {
          account = {
            id: newId('acc'),
            provider: p.provider,
            name: providers[p.provider].name,
            protocol: p.protocol,
            host: p.host,
            port: p.port,
            username: p.username ?? '',
            password: p.password ?? '',
            createdAt: Date.now(),
          };
          this.data.accounts.push(account);
        } else {
          account.password = p.password ?? account.password;
        }
        const exits = this.makeProviderExits(
          {
            accountId: account.id,
            mode: validMode(input.mode),
            country: input.country !== undefined ? input.country : p.country,
            city: input.city !== undefined ? input.city : p.city,
            sessionMinutes: input.sessionMinutes,
            count: input.count ?? 3,
          },
          taken,
        );
        created.push(...exits);
      } else {
        const exit: Exit = {
          kind: 'proxy',
          id: newId('exit'),
          name: `${p.host}:${p.port}`,
          createdAt: Date.now(),
          proxy: { protocol: p.protocol, host: p.host, port: p.port, username: p.username || undefined, password: p.password || undefined },
        };
        created.push(exit);
      }
    }
    this.addExits(created);
    return { created: created.length, invalid, state: this.getState() };
  }

  createExits(input: CreateExitsInput) {
    if (!this.data.accounts.some((a) => a.id === input.accountId)) throw new ApiError(404, 'That account no longer exists');
    const exits = this.makeProviderExits({ ...input, mode: validMode(input.mode) });
    this.addExits(exits);
    return { created: exits.length, state: this.getState() };
  }

  updateExit(
    id: string,
    patch: Partial<{ name: string; mode: ExitMode; country: string; city: string; sessionMinutes: number | null; proxy: Partial<ProxyEndpoint>; port: number }>,
  ) {
    const exit = this.exitOr404(id);
    if (typeof patch.name === 'string' && patch.name.trim()) exit.name = patch.name.trim().slice(0, 60);
    if (patch.port !== undefined && Number(patch.port) !== exit.port) {
      const port = Number(patch.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ApiError(400, 'Use a port between 1024 and 65535');
      if (port === this.settings.gatewayPort || this.data.exits.some((e) => e.id !== id && e.port === port)) {
        throw new ApiError(400, `Port ${port} is already used by Proxy App`);
      }
      exit.port = port;
      void this.syncPinned();
    }
    let routeChanged = false;
    if (exit.kind === 'provider') {
      if (patch.mode && patch.mode !== exit.mode) {
        exit.mode = validMode(patch.mode);
        routeChanged = true;
      }
      if (patch.country !== undefined && (patch.country.toLowerCase() || undefined) !== exit.country) {
        exit.country = patch.country.toLowerCase() || undefined;
        routeChanged = true;
      }
      if (patch.city !== undefined && (patch.city.trim() || undefined) !== exit.city) {
        exit.city = patch.city.trim() || undefined;
        routeChanged = true;
      }
      if (patch.sessionMinutes !== undefined && (patch.sessionMinutes || undefined) !== exit.sessionMinutes) {
        exit.sessionMinutes = patch.sessionMinutes || undefined;
        routeChanged = true;
      }
      if (routeChanged) {
        exit.session = sessionId();
        exit.sessionStartedAt = Date.now();
      }
    } else if (patch.proxy) {
      const next = { ...exit.proxy, ...patch.proxy };
      if (!PROTOCOLS.includes(next.protocol) || !next.host || !(next.port >= 1 && next.port <= 65535)) throw new ApiError(400, 'Enter a valid host and port');
      exit.proxy = next;
      routeChanged = true;
    }
    if (routeChanged) {
      exit.lastCheck = undefined;
      this.dropExits([id]);
      void this.checkExit(id).catch(() => {});
    }
    this.store.save();
    this.changed();
    return this.getState();
  }

  async deleteExit(id: string) {
    this.exitOr404(id);
    this.data.exits = this.data.exits.filter((e) => e.id !== id);
    await this.afterExitRemoval();
    return this.getState();
  }

  reorderExits(ids: string[]) {
    const order = new Map(ids.map((id, i) => [id, i]));
    this.data.exits.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    this.store.save();
    this.changed();
    return this.getState();
  }

  private async afterExitRemoval() {
    // Apps pinned to a removed IP fall back to following the app.
    for (const rule of Object.values(this.data.appRules)) {
      if (rule.exitId && !this.data.exits.some((e) => e.id === rule.exitId)) rule.exitId = null;
    }
    if (!this.activeExit()) {
      this.data.activeExitId = this.data.exits[0]?.id ?? null;
      if (this.status === 'on' && this.settings.dropOnSwitch) this.gateway.drop((c) => c.pinned === null);
    }
    this.store.save();
    await this.syncPinned();
    if (!this.data.activeExitId && this.status === 'on') await this.disconnect();
  }

  // ---------- accounts ----------

  updateAccount(id: string, patch: Partial<Pick<Account, 'name' | 'username' | 'password' | 'host' | 'port' | 'protocol'>>) {
    const account = this.data.accounts.find((a) => a.id === id);
    if (!account) throw new ApiError(404, 'That account no longer exists');
    if (typeof patch.name === 'string' && patch.name.trim()) account.name = patch.name.trim().slice(0, 60);
    let credsChanged = false;
    if (typeof patch.username === 'string' && patch.username.trim() && patch.username.trim() !== account.username) {
      // Accept a pasted login with parameters; keep only the base.
      account.username = providers[account.provider].parseLogin(patch.username.trim()).base;
      credsChanged = true;
    }
    if (typeof patch.password === 'string' && patch.password && patch.password !== account.password) {
      account.password = patch.password;
      credsChanged = true;
    }
    if (typeof patch.host === 'string' && patch.host.trim() && patch.host.trim() !== account.host) {
      account.host = patch.host.trim();
      credsChanged = true;
    }
    if (patch.port !== undefined && Number(patch.port) !== account.port) {
      const port = Number(patch.port);
      if (!(port >= 1 && port <= 65535)) throw new ApiError(400, 'Port must be between 1 and 65535');
      account.port = port;
      credsChanged = true;
    }
    if (patch.protocol && patch.protocol !== account.protocol) {
      if (!PROTOCOLS.includes(patch.protocol)) throw new ApiError(400, 'Unknown protocol');
      account.protocol = patch.protocol;
      credsChanged = true;
    }
    if (credsChanged) {
      this.upstreamError = undefined;
      this.upstreamFailures = 0;
      const ids = this.data.exits.filter((e) => e.kind === 'provider' && e.accountId === id).map((e) => e.id);
      this.dropExits(ids);
      void this.checkMany(ids);
    }
    this.store.save();
    this.changed();
    return this.getState();
  }

  async deleteAccount(id: string) {
    if (!this.data.accounts.some((a) => a.id === id)) throw new ApiError(404, 'That account no longer exists');
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.data.exits = this.data.exits.filter((e) => e.kind !== 'provider' || e.accountId !== id);
    await this.afterExitRemoval();
    return this.getState();
  }

  async testProxy(input: TestProxyInput): Promise<TestProxyResult> {
    const line = (input.text ?? '').split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
    const parsed = parseProxyLine(line);
    if (!parsed) return { parsed: null, check: { at: Date.now(), ok: false, error: "That doesn't look like a proxy. Use login:password@host:port." } };
    let username = parsed.username;
    if (parsed.provider) {
      const sticky = validMode(input.mode) === 'sticky';
      username = providers[parsed.provider].buildLogin(parsed.username ?? '', {
        country: input.country !== undefined ? input.country : parsed.country,
        city: input.city !== undefined ? input.city : parsed.city,
        session: sticky ? sessionId() : undefined,
      });
    }
    const check = await checkUpstream({ protocol: parsed.protocol, host: parsed.host, port: parsed.port, username, password: parsed.password });
    return { parsed: { ...parsed, password: parsed.password ? '••••' : '' }, check };
  }

  // ---------- settings ----------

  updateSettings(patch: Partial<Settings>): Promise<AppState> {
    return this.exclusive(async () => {
      const prev = structuredClone(this.settings);
      const next = { ...prev };
      if (patch.gatewayPort !== undefined) {
        const port = Number(patch.gatewayPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ApiError(400, 'Use a port between 1024 and 65535');
        if (this.data.exits.some((e) => e.port === port)) throw new ApiError(400, `Port ${port} is already a fixed port for one of your IPs`);
        next.gatewayPort = port;
      }
      if (typeof patch.allowLan === 'boolean') next.allowLan = patch.allowLan;
      if (patch.lanAuth) {
        next.lanAuth = {
          enabled: Boolean(patch.lanAuth.enabled ?? prev.lanAuth.enabled),
          username: String(patch.lanAuth.username ?? prev.lanAuth.username).trim() || 'proxy',
          password: String(patch.lanAuth.password ?? prev.lanAuth.password),
        };
        if (next.lanAuth.enabled && !next.lanAuth.password) throw new ApiError(400, 'Set a password to require a login');
      }
      if (typeof patch.systemProxy === 'boolean') next.systemProxy = patch.systemProxy;
      if (typeof patch.dropOnSwitch === 'boolean') next.dropOnSwitch = patch.dropOnSwitch;
      if (patch.autoRotateMinutes !== undefined) {
        const m = Number(patch.autoRotateMinutes);
        if (!Number.isFinite(m) || m < 0 || m > 1440) throw new ApiError(400, 'Pick between 0 and 1440 minutes');
        next.autoRotateMinutes = Math.round(m);
      }
      if (Array.isArray(patch.bypass)) next.bypass = patch.bypass.map((b) => String(b).trim()).filter(Boolean).slice(0, 200);
      if (typeof patch.startConnected === 'boolean') next.startConnected = patch.startConnected;
      if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin;
      if (patch.theme && ['system', 'light', 'dark'].includes(patch.theme)) next.theme = patch.theme;

      this.data.settings = next;
      this.store.save();

      const gatewayChanged =
        next.gatewayPort !== prev.gatewayPort || next.allowLan !== prev.allowLan || JSON.stringify(next.lanAuth) !== JSON.stringify(prev.lanAuth);
      if (gatewayChanged && this.status !== 'on') await this.gateway.start(this.gatewayConfig()).catch(() => {});
      if (this.status === 'on') {
        const sysChanged = next.systemProxy !== prev.systemProxy || next.gatewayPort !== prev.gatewayPort || next.bypass.join() !== prev.bypass.join();
        if (sysChanged) await this.restoreSystemProxy();
        if (gatewayChanged) {
          try {
            await this.gateway.start(this.gatewayConfig());
          } catch (err) {
            this.status = 'error';
            this.statusError = err instanceof Error ? err.message : String(err);
          }
        }
        if (sysChanged && next.systemProxy && this.status === 'on') await this.applySystemProxy();
        if (next.autoRotateMinutes !== prev.autoRotateMinutes) this.scheduleRotate();
      }
      this.changed();
      return this.getState();
    });
  }

  resetUsage() {
    this.data.usage = { up: 0, down: 0, since: Date.now() };
    this.store.save();
    this.changed();
    return this.getState();
  }

  // ---------- browser profiles ----------

  /** Copies the bundled extension into the data folder, so browsers load it from a path that survives app updates. */
  private installExtension() {
    const src = this.opts.extensionSource;
    if (!src || !fs.existsSync(path.join(src, 'manifest.json'))) return;
    try {
      copyDir(src, this.extensionDir);
    } catch (err) {
      console.error("Couldn't install the browser extension files:", err instanceof Error ? err.message : err);
    }
  }

  browserProfiles(): BrowserProfile[] {
    return listProfiles(this.extensionDir);
  }

  /** Profiles plus whether each browser is open, for the Apps screen. */
  async browserProfilesLive(): Promise<BrowserProfile[]> {
    const procs = await listProcesses();
    const open = new Map<string, boolean>();
    return this.browserProfiles().map((p) => {
      if (!open.has(p.browser)) {
        const app = browserApp(p.browser);
        open.set(p.browser, Boolean(app && findMain(app, procs)));
      }
      return { ...p, running: open.get(p.browser)! };
    });
  }

  openBrowserProfile(browser: BrowserId, dir: string, url: string) {
    // Only open profiles we found ourselves; never pass arbitrary input to a browser.
    if (!this.browserProfiles().some((p) => p.browser === browser && p.dir === dir)) throw new ApiError(404, 'That browser profile was not found');
    try {
      openProfile(browser, dir, url);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Switches one Chrome/Edge/Brave profile by writing its own proxy setting.
   * The browser rewrites that file while running, so a running browser is quit
   * first and reopened with its windows.
   */
  async setBrowserProfileProxy(browser: BrowserId, dir: string, enabled: boolean, exitId: string | null) {
    const profile = this.browserProfiles().find((p) => p.browser === browser && p.dir === dir);
    if (!profile) throw new ApiError(404, 'That browser profile was not found');
    if (profile.kind === 'prefs') return { ...this.setFirefoxProxy(dir, enabled), restarted: false, needsQuit: false };
    if (exitId && !this.data.exits.some((e) => e.id === exitId)) throw new ApiError(404, 'That IP is no longer in your list');
    const want = enabled ? this.portFor(exitId) : null;
    if (profile.proxyPort === want) return { ok: true, restarted: false, needsQuit: false };

    const app = browserApp(browser);
    if (!app) throw new ApiError(400, `Couldn't find ${profile.browserName} on this computer`);
    const running = findMain(app, await listProcesses()) !== null;
    if (running && !(await quitApp(app, 20_000))) {
      return { ok: false, restarted: false, needsQuit: true };
    }
    try {
      writeProfileProxy(browser, dir, want);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    } finally {
      // Bring the browser back the way it was, whether or not the write worked.
      if (running) launchApp(app, ['--restore-last-session']);
    }
    return { ok: true, restarted: running, needsQuit: false };
  }

  setFirefoxProxy(dir: string, enabled: boolean) {
    try {
      setFirefoxProxy(dir, enabled ? this.settings.gatewayPort : null);
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : String(err));
    }
    return { ok: true };
  }

  revealExtension() {
    if (!fs.existsSync(path.join(this.extensionDir, 'manifest.json'))) throw new ApiError(404, 'The extension files are missing. Reinstall Proxy App.');
    revealFolder(this.extensionDir);
  }

  // ---------- apps ----------

  /** The gateway port an app should use: an IP's fixed port, or the main one. */
  private portFor(exitId: string | null): number {
    const exit = exitId ? this.data.exits.find((e) => e.id === exitId) : null;
    return exit?.port ?? this.settings.gatewayPort;
  }

  async listApps(refresh = false): Promise<InstalledApp[]> {
    const [apps, procs] = await Promise.all([scanApps(refresh), listProcesses()]);
    const port = String(this.settings.gatewayPort);
    return apps.map((a) => {
      const main = findMain(a, procs);
      return {
        id: a.id,
        name: a.name,
        path: a.path,
        engine: a.engine,
        method: a.method,
        hint: a.hint?.replaceAll('{port}', port),
        running: main !== null,
        proxyPort: proxyPortOf(main),
        rule: this.data.appRules[a.id] ?? null,
      };
    });
  }

  private async launchable(id: string) {
    const app = (await scanApps()).find((a) => a.id === id);
    if (!app) throw new ApiError(404, 'That app is no longer installed');
    if (app.method !== 'launch') throw new ApiError(400, `${app.name} needs its proxy set inside the app`);
    return app;
  }

  /**
   * Turns the proxy on or off for one app. Chromium-based apps only read the
   * proxy at start, so a running app is quit and reopened.
   */
  async setAppProxy(id: string, enabled: boolean, exitId: string | null = null) {
    const app = await this.launchable(id);
    if (exitId && !this.data.exits.some((e) => e.id === exitId)) throw new ApiError(404, 'That IP is no longer in your list');
    if (enabled) this.data.appRules[id] = { exitId };
    else delete this.data.appRules[id];
    this.store.save();
    this.changed();

    const main = findMain(app, await listProcesses());
    const want = enabled ? this.portFor(exitId) : null;
    if (!main || proxyPortOf(main) === want) return { restarted: false, needsQuit: false, state: this.getState() };
    if (!(await quitApp(app))) return { restarted: false, needsQuit: true, state: this.getState() };
    launchApp(app, want ? proxyArgs(want) : []);
    return { restarted: true, needsQuit: false, state: this.getState() };
  }

  /** Opens the app the way its rule says: through the proxy, or normally. */
  async openApp(id: string) {
    const app = await this.launchable(id);
    const rule = this.data.appRules[id];
    if (findMain(app, await listProcesses())) {
      if (!rule) throw new ApiError(409, `${app.name} is already open`);
      return this.setAppProxy(id, true, rule.exitId);
    }
    launchApp(app, rule ? proxyArgs(this.portFor(rule.exitId)) : []);
    return { restarted: false, needsQuit: false, state: this.getState() };
  }

  async appIcon(id: string): Promise<Buffer | null> {
    const app = (await scanApps()).find((a) => a.id === id);
    return app ? appIcon(app, path.join(this.store.dir, 'icon-cache'), this.opts.iconProvider) : null;
  }

  openTerminal(exitId: string | null) {
    openProxyTerminal(this.portFor(exitId), this.store.dir);
    return { ok: true };
  }
}

/** Plain read/write copy: also works when the source sits inside Electron's app.asar. */
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function validMode(mode: unknown): ExitMode {
  return mode === 'rotating' ? 'rotating' : 'sticky';
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** For phones: Settings → Wi-Fi → Proxy → Automatic, with this URL. */
function pacScript(address: string): string {
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" || dnsDomainIs(host, ".local")) return "DIRECT";
  if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host) && (
    isInNet(host, "10.0.0.0", "255.0.0.0") ||
    isInNet(host, "172.16.0.0", "255.240.0.0") ||
    isInNet(host, "192.168.0.0", "255.255.0.0") ||
    isInNet(host, "127.0.0.0", "255.0.0.0") ||
    isInNet(host, "169.254.0.0", "255.255.0.0"))) return "DIRECT";
  return "PROXY ${address}";
}
`;
}
