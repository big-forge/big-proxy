// Contract between the core (Node) and the UI. Everything here crosses the
// control API as JSON, so keep it plain data.

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface ProxyEndpoint {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export type ProviderId = 'dataimpulse';

/** A login at a proxy provider that understands targeting parameters. */
export interface Account {
  id: string;
  provider: ProviderId;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  /** Base login with provider parameters (country, session…) stripped. */
  username: string;
  password: string;
  createdAt: number;
}

export interface IpInfo {
  ip: string;
  countryCode?: string;
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
}

export type CheckErrorCode = 'auth' | 'unreachable' | 'timeout' | 'refused' | 'protocol' | 'target' | 'lookup';

export interface ExitCheck {
  at: number;
  ok: boolean;
  latencyMs?: number;
  info?: IpInfo;
  error?: string;
  errorCode?: CheckErrorCode;
}

interface ExitBase {
  id: string;
  name: string;
  createdAt: number;
  lastCheck?: ExitCheck;
  /** Local port that always uses this exit, whatever is selected in the app. */
  port?: number;
}

/** sticky = one IP held for a while; rotating = a new IP on every connection. */
export type ExitMode = 'sticky' | 'rotating';

export interface ProviderExit extends ExitBase {
  kind: 'provider';
  accountId: string;
  mode: ExitMode;
  /** ISO 3166 alpha-2, lowercase. Empty = provider default. */
  country?: string;
  city?: string;
  /** Sticky session id. Replacing it is how "New IP" works. */
  session: string;
  /** How long the provider should hold a sticky IP. Undefined = provider default. */
  sessionMinutes?: number;
  sessionStartedAt: number;
}

/** A plain proxy used exactly as given (static IP, or another provider's gateway). */
export interface ProxyExit extends ExitBase {
  kind: 'proxy';
  proxy: ProxyEndpoint;
}

export type Exit = ProviderExit | ProxyExit;

export interface Settings {
  gatewayPort: number;
  /** Accept connections from phones and other computers on the local network. */
  allowLan: boolean;
  lanAuth: { enabled: boolean; username: string; password: string };
  /** Point this computer's system proxy at the gateway while connected. */
  systemProxy: boolean;
  /** Close open connections on switch so every app moves to the new IP at once. */
  dropOnSwitch: boolean;
  /** 0 = off. Applies to the active sticky exit while connected. */
  autoRotateMinutes: number;
  bypass: string[];
  startConnected: boolean;
  launchAtLogin: boolean;
  theme: 'system' | 'light' | 'dark';
}

export type ConnectionStatus = 'off' | 'connecting' | 'on' | 'error';

export interface AppState {
  version: string;
  platform: string;
  shell: 'desktop' | 'app' | 'web';
  dataDir: string;
  status: ConnectionStatus;
  statusError?: string;
  systemProxyActive: boolean;
  systemProxyError?: string;
  activeExitId: string | null;
  accounts: Account[];
  exits: Exit[];
  settings: Settings;
  checking: string[];
  lanAddresses: string[];
  usage: { up: number; down: number; since: number };
  /** Set when the upstream keeps failing, so the UI can say what is wrong. */
  upstreamError?: { at: number; message: string };
  /** Exit id → why its fixed port couldn't open (usually: port taken). */
  pinnedErrors: Record<string, string>;
  /** Folder to load as an unpacked extension in Chrome-family browsers. */
  extensionDir: string;
  /** App id → which IP it should use when Proxy App launches it. */
  appRules: Record<string, AppRule>;
  /** Desktop app only. */
  update?: UpdateState;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  /** Newest version found. */
  version?: string;
  /** 0–100 while downloading. */
  progress?: number;
  error?: string;
  /** false = this system can't install it by itself (unsigned macOS build); the app opens the download page instead. */
  canInstall: boolean;
  checkedAt?: number;
}

export interface AppRule {
  /** null = follow the IP selected in the app. */
  exitId: string | null;
}

export type AppEngine = 'electron' | 'cef' | 'chromium' | 'native';

/** launch = Proxy App restarts it with the proxy; inside = it has its own proxy setting; system = only the system proxy reaches it. */
export type AppMethod = 'launch' | 'inside' | 'system';

export interface InstalledApp {
  id: string;
  name: string;
  path: string;
  engine: AppEngine;
  method: AppMethod;
  /** Where the proxy setting lives, for `inside` apps. */
  hint?: string;
  running: boolean;
  /** Gateway port the running app was started with; null = running without the proxy. */
  proxyPort: number | null;
  rule: AppRule | null;
}

export type BrowserId = 'chrome' | 'edge' | 'brave' | 'chromium' | 'firefox';

export interface BrowserProfile {
  browser: BrowserId;
  browserName: string;
  /** Folder name inside the browser's user data, e.g. "Profile 2". */
  dir: string;
  name: string;
  email?: string;
  /** extension = Chrome-family, set up with our extension; prefs = Firefox, switched through its user.js. */
  kind: 'extension' | 'prefs';
  /** Proxy App is active in this profile (extension loaded, or our Firefox prefs written). */
  extension: 'on' | 'disabled' | 'missing';
  /** Chrome-family: gateway port written into the profile's own proxy setting (no extension needed). */
  proxyPort: number | null;
  /** The browser is open right now (changing its profile settings means restarting it). */
  running: boolean;
}

/** What the gateway tells the browser extension. No secrets. */
export interface GatewayStatus {
  app: 'proxy-app';
  version: string;
  connected: boolean;
  port: number;
  activeExitId: string | null;
  exits: { id: string; name: string; port: number | null; ip?: string; countryCode?: string; city?: string; latencyMs?: number; mode: string }[];
}

export interface TrafficStats {
  at: number;
  /** Bytes per second over the last tick. */
  upRate: number;
  downRate: number;
  /** Bytes since connecting. */
  up: number;
  down: number;
  active: number;
}

export type ActivityKind = 'http' | 'connect' | 'socks';

export interface ActivityEntry {
  id: number;
  at: number;
  kind: ActivityKind;
  client: string;
  host: string;
  port: number;
  exitId: string | null;
  direct: boolean;
  up: number;
  down: number;
  status: 'open' | 'closed' | 'failed';
  durationMs?: number;
  error?: string;
}

// ---- Control API inputs ----

export interface ParsedProxy extends ProxyEndpoint {
  provider: ProviderId | null;
  /** Targeting found inside a provider login, e.g. `login__cr.in`. */
  country?: string;
  city?: string;
}

export interface AddProxiesInput {
  /** One proxy per line, any common format. */
  text: string;
  /** For provider logins: how many exits to create, and with what targeting. */
  mode?: ExitMode;
  country?: string;
  city?: string;
  sessionMinutes?: number;
  count?: number;
}

export interface CreateExitsInput {
  accountId: string;
  mode: ExitMode;
  country?: string;
  city?: string;
  sessionMinutes?: number;
  count: number;
}

export interface TestProxyInput {
  text: string;
  mode?: ExitMode;
  country?: string;
  city?: string;
}

export interface TestProxyResult {
  parsed: ParsedProxy | null;
  check: ExitCheck;
}
