import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ActivityEntry, ActivityKind, GatewayStatus, ProxyEndpoint } from '../shared/types';
import { isLocalTarget, isLoopback, isLoopbackTarget, isPrivate, normalizeAddress, parseHostPort } from './net-utils';
import { safeEqual } from './secure';
import { SocketReader } from './socket-reader';
import { acceptSocks5, socksReply, socksReplyFor } from './socks5';
import { basicAuth, connectProxy, httpStatusError, openTunnel, UpstreamError } from './upstream';

const IDLE_TIMEOUT = 5 * 60_000;
const MAX_HEAD = 64 * 1024;

export interface GatewayConfig {
  port: number;
  allowLan: boolean;
  /** Required from non-loopback clients when set. */
  lanAuth: { username: string; password: string } | null;
  /** Extra ports that always use one exit, whatever is active. */
  pinned: PinnedPort[];
}

export interface PinnedPort {
  exitId: string;
  port: number;
}

export interface Route {
  upstream: ProxyEndpoint;
  exitId: string;
}

export interface GatewayHooks {
  /** The active exit, or a specific one for a pinned port. */
  route(exitId?: string): Route | null;
  pac(proxyAddress: string): string;
  upstreamResult(err: UpstreamError | null): void;
  /** Served to the browser extension at /proxy-app.json. */
  status(): GatewayStatus;
  /** Actions the browser extension may ask for (connect, new IP…). */
  control(action: string, body: Record<string, unknown>): Promise<unknown>;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Conn {
  client: net.Socket;
  upstream?: net.Socket;
  entry?: ActivityEntry;
  started: number;
  /** Exit id when the client came in on a pinned port; null for the main port. */
  pinned: string | null;
  local: boolean;
}

export interface ConnInfo {
  pinned: string | null;
  exitId: string | null;
}

interface HttpHead {
  method: string;
  target: string;
  version: string;
  headers: [string, string][];
}

type Events = { activity: [ActivityEntry] };

/**
 * The local proxy every app talks to. One port speaks HTTP (plain and
 * CONNECT) and SOCKS5, decided by the first byte. The main port routes each
 * new connection through whatever exit is active at that moment; pinned
 * ports always use their own exit, so two browser profiles can hold two IPs.
 */
export class Gateway extends EventEmitter<Events> {
  private server: net.Server | null = null;
  private pinnedServers = new Map<string, { port: number; server: net.Server }>();
  private pinErrors = new Map<string, string>();
  private cfg: GatewayConfig | null = null;
  /** Standby (false): listening so the extension can reach us, but routing nothing. */
  private active = false;
  private conns = new Set<Conn>();
  private closedUp = 0;
  private closedDown = 0;
  private nextId = 1;

  constructor(private readonly hooks: GatewayHooks) {
    super();
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Off = keep listening, refuse traffic. Apps pointed at us fail instead of leaking. */
  setActive(active: boolean) {
    this.active = active;
    if (!active) this.dropAll();
  }

  /** Exit id → why its pinned port isn't listening. */
  get pinnedErrors(): Record<string, string> {
    return Object.fromEntries(this.pinErrors);
  }

  async start(cfg: GatewayConfig): Promise<void> {
    if (this.server) await this.stop();
    this.server = await this.listen(cfg.port, cfg.allowLan, null).catch((err: NodeJS.ErrnoException) => {
      throw new Error(portMessage(err, cfg.port, 'Pick a different port in Settings.'));
    });
    this.cfg = cfg;
    this.closedUp = 0;
    this.closedDown = 0;
    await this.syncPinned(cfg.pinned);
  }

  /** Opens and closes pinned ports to match the list. A busy port is reported, not fatal. */
  async syncPinned(pinned: PinnedPort[]): Promise<void> {
    const cfg = this.cfg;
    if (!cfg) return;
    cfg.pinned = pinned;
    const wanted = new Map(pinned.map((p) => [p.exitId, p.port]));
    for (const [exitId, { port, server }] of this.pinnedServers) {
      if (wanted.get(exitId) !== port) {
        this.pinnedServers.delete(exitId);
        this.drop((c) => c.pinned === exitId);
        server.close();
      }
    }
    for (const exitId of this.pinErrors.keys()) if (!wanted.has(exitId)) this.pinErrors.delete(exitId);
    for (const { exitId, port } of pinned) {
      if (this.pinnedServers.has(exitId)) continue;
      try {
        this.pinnedServers.set(exitId, { port, server: await this.listen(port, cfg.allowLan, exitId) });
        this.pinErrors.delete(exitId);
      } catch (err) {
        this.pinErrors.set(exitId, portMessage(err as NodeJS.ErrnoException, port, 'Pick another port for this IP.'));
      }
    }
  }

  private listen(port: number, allowLan: boolean, pinned: string | null): Promise<net.Server> {
    const server = net.createServer({ noDelay: true }, (sock) => this.onConnection(sock, pinned));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, allowLan ? '0.0.0.0' : '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', () => {});
        resolve(server);
      });
    });
  }

  async stop(): Promise<void> {
    const servers = [this.server, ...[...this.pinnedServers.values()].map((p) => p.server)].filter((s): s is net.Server => s !== null);
    this.server = null;
    this.active = false;
    this.pinnedServers.clear();
    this.pinErrors.clear();
    this.cfg = null;
    this.dropAll();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  /** Ends matching open connections so their apps reconnect through the current exit. */
  drop(match: (c: ConnInfo) => boolean): number {
    let count = 0;
    for (const conn of this.conns) {
      if (!match({ pinned: conn.pinned, exitId: conn.entry?.exitId ?? conn.pinned })) continue;
      conn.client.destroy();
      conn.upstream?.destroy();
      count++;
    }
    return count;
  }

  dropAll(): number {
    return this.drop(() => true);
  }

  totals(): { up: number; down: number; active: number } {
    let up = this.closedUp;
    let down = this.closedDown;
    let active = 0;
    for (const conn of this.conns) {
      up += conn.client.bytesRead;
      down += conn.client.bytesWritten;
      if (conn.entry) active++;
    }
    return { up, down, active };
  }

  private onConnection(client: net.Socket, pinned: string | null) {
    const cfg = this.cfg;
    const remote = normalizeAddress(client.remoteAddress);
    const local = isLoopback(remote);
    if (!cfg || (!local && !(cfg.allowLan && isPrivate(remote)))) {
      client.destroy();
      return;
    }
    const conn: Conn = { client, started: Date.now(), pinned, local };
    this.conns.add(conn);
    client.setTimeout(IDLE_TIMEOUT, () => client.destroy());
    client.on('error', () => {});
    client.once('close', () => this.finish(conn));

    const auth = local ? null : cfg.lanAuth;
    const reader = new SocketReader(client);
    this.handle(conn, reader, remote, local, auth).catch(() => client.destroy());
  }

  private async handle(conn: Conn, reader: SocketReader, remote: string, local: boolean, auth: GatewayConfig['lanAuth']) {
    const [first] = await reader.read(1);
    if (first === 0x05) return this.handleSocks(conn, reader, remote, local, auth);
    // SOCKS4 and TLS-to-the-proxy are not supported; drop quietly.
    if (first === 0x04 || first === 0x16) throw new Error('Unsupported protocol');

    const head = parseHead(Buffer.concat([Buffer.from([first]), await reader.readUntil('\r\n\r\n', MAX_HEAD)]).toString('latin1'));
    if (!head) return respond(conn.client, 400, 'Bad request');

    if (head.method === 'CONNECT') {
      const target = parseHostPort(head.target, 443);
      if (!target) return respond(conn.client, 400, 'Bad CONNECT target');
      if (auth && !checkBasic(head.headers, auth)) return respondAuth(conn.client);
      return this.handleConnect(conn, reader, remote, local, target.host, target.port);
    }

    if (head.target.startsWith('http://')) {
      if (auth && !checkBasic(head.headers, auth)) return respondAuth(conn.client);
      return this.handlePlainHttp(conn, reader, remote, local, head);
    }

    if (head.target.startsWith('/')) return this.serveSelf(conn, reader, head);
    return respond(conn.client, 400, 'Only http:// URLs can be proxied directly. Use CONNECT for https.');
  }

  private async handleSocks(conn: Conn, reader: SocketReader, remote: string, local: boolean, auth: GatewayConfig['lanAuth']) {
    const target = await acceptSocks5(conn.client, reader, auth);
    const entry = this.open(conn, 'socks', remote, target.host, target.port);
    try {
      const { sock } = await this.tunnelFor(conn, entry, target.host, target.port, local);
      socksReply(conn.client, 0);
      this.bridge(conn, sock, reader.detach());
    } catch (err) {
      this.fail(entry, err);
      socksReply(conn.client, err instanceof GatewayError ? 2 : socksReplyFor(err));
      conn.client.end();
    }
  }

  private async handleConnect(conn: Conn, reader: SocketReader, remote: string, local: boolean, host: string, port: number) {
    const entry = this.open(conn, 'connect', remote, host, port);
    try {
      const { sock } = await this.tunnelFor(conn, entry, host, port, local);
      conn.client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      this.bridge(conn, sock, reader.detach());
    } catch (err) {
      this.fail(entry, err);
      respondError(conn.client, err);
    }
  }

  private async handlePlainHttp(conn: Conn, reader: SocketReader, remote: string, local: boolean, head: HttpHead) {
    let url: URL;
    try {
      url = new URL(head.target);
    } catch {
      return respond(conn.client, 400, 'Bad URL');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = url.port ? Number(url.port) : 80;
    const entry = this.open(conn, 'http', remote, host, port);
    try {
      const route = this.routeFor(conn, host, local);
      entry.exitId = route?.exitId ?? null;
      entry.direct = route === null;
      const viaHttpProxy = route !== null && route.upstream.protocol !== 'socks5';
      let sock: net.Socket;
      if (viaHttpProxy) {
        try {
          sock = await connectProxy(route.upstream);
        } catch (err) {
          if (err instanceof UpstreamError) this.hooks.upstreamResult(err);
          throw err;
        }
      } else {
        sock = (await this.tunnelFor(conn, entry, host, port, local)).sock;
      }

      const lines = [`${head.method} ${viaHttpProxy ? head.target : url.pathname + url.search} ${head.version}`];
      let hasHost = false;
      for (const [name, value] of head.headers) {
        const lower = name.toLowerCase();
        if (lower === 'host') hasHost = true;
        if (HOP_BY_HOP.has(lower)) continue;
        lines.push(`${name}: ${value}`);
      }
      if (!hasHost) lines.push(`Host: ${url.host}`);
      const auth = viaHttpProxy ? basicAuth(route.upstream.username, route.upstream.password) : null;
      if (auth) lines.push(`Proxy-Authorization: ${auth}`);
      // One request per upstream connection keeps auth and routing simple.
      lines.push('Connection: close');
      sock.write(lines.join('\r\n') + '\r\n\r\n');

      if (viaHttpProxy) {
        // Catch a 407 so the user's app doesn't pop up a login prompt for our upstream.
        const upReader = new SocketReader(sock);
        const resHead = await upReader.readUntil('\r\n\r\n', MAX_HEAD).catch(() => null);
        const early = upReader.detach();
        if (!resHead) throw new UpstreamError('protocol', 'The proxy closed the connection without answering');
        const status = Number(resHead.toString('latin1').split(' ', 3)[1]);
        if (status === 407) {
          sock.destroy();
          const err = httpStatusError(407, url.host);
          this.hooks.upstreamResult(err);
          throw err;
        }
        this.hooks.upstreamResult(null);
        conn.client.write(Buffer.concat([resHead, early]));
      }
      this.bridge(conn, sock, reader.detach());
    } catch (err) {
      this.fail(entry, err);
      respondError(conn.client, err);
    }
  }

  private async serveSelf(conn: Conn, reader: SocketReader, head: HttpHead) {
    const { client } = conn;
    const path = head.target.split('?')[0];
    const header = (name: string) => head.headers.find(([n]) => n.toLowerCase() === name)?.[1];
    if (path === '/proxy.pac' || path === '/wpad.dat') {
      const hostHeader = header('host') ?? '';
      const address = hostHeader.includes(':') ? hostHeader : `${hostHeader}:${this.cfg?.port ?? ''}`;
      return respond(client, 200, this.hooks.pac(address), 'application/x-ns-proxy-autoconfig');
    }
    if (path === '/proxy-app.json') {
      // For the browser extension only: this computer, and no web page origins.
      const origin = header('origin');
      if (!conn.local || (origin && !/^(chrome|moz|edge)-extension:\/\//.test(origin))) return respond(client, 403, 'Forbidden');
      return respond(client, 200, JSON.stringify(this.hooks.status()), 'application/json', ['Cache-Control: no-store']);
    }
    const action = path.match(/^\/proxy-app\/([a-z-]+)$/)?.[1];
    if (action && head.method === 'POST') {
      // Only from this computer, and only from a browser extension (web pages can't fake Origin).
      const origin = header('origin');
      if (!conn.local || !origin || !/^(chrome|moz|edge)-extension:\/\//.test(origin)) return respond(client, 403, 'Forbidden');
      const length = Math.min(Number(header('content-length') ?? 0) || 0, 64 * 1024);
      let body: Record<string, unknown> = {};
      try {
        if (length) body = JSON.parse((await reader.read(length)).toString('utf8'));
      } catch {
        return respond(client, 400, '{"error":"Bad JSON"}', 'application/json');
      }
      try {
        return respond(client, 200, JSON.stringify((await this.hooks.control(action, body)) ?? { ok: true }), 'application/json', ['Cache-Control: no-store']);
      } catch (err) {
        const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 500;
        return respond(client, status, JSON.stringify({ error: err instanceof Error ? err.message : 'Failed' }), 'application/json');
      }
    }
    return respond(client, 200, 'Proxy App gateway is running. Use this address as an HTTP or SOCKS5 proxy.');
  }

  /** Decides where a target goes: null = straight out, no exit. */
  private routeFor(conn: Conn, host: string, local: boolean): Route | null {
    if (isLoopbackTarget(host) && !local) {
      // A phone on the Wi-Fi must never reach this computer's own services through us.
      throw new GatewayError(403, 'Blocked: devices on the network cannot reach this computer through the proxy');
    }
    if (!this.active) throw new GatewayError(503, 'Proxy App is off. Connect it in the app, or from the Proxy App button in your browser.');
    if (isLocalTarget(host)) return null;
    const route = this.hooks.route(conn.pinned ?? undefined);
    if (!route) {
      throw new GatewayError(503, conn.pinned ? 'This IP was removed from Proxy App.' : 'Proxy App has no exit selected. Open the app and pick one.');
    }
    return route;
  }

  private async tunnelFor(conn: Conn, entry: ActivityEntry, host: string, port: number, local: boolean) {
    const route = this.routeFor(conn, host, local);
    entry.exitId = route?.exitId ?? null;
    entry.direct = route === null;
    if (!route) return { sock: await openTunnel(null, host, port) };
    try {
      const sock = await openTunnel(route.upstream, host, port);
      this.hooks.upstreamResult(null);
      return { sock };
    } catch (err) {
      if (err instanceof UpstreamError) this.hooks.upstreamResult(err);
      throw err;
    }
  }

  private bridge(conn: Conn, upstream: net.Socket, early: Buffer) {
    const { client } = conn;
    conn.upstream = upstream;
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.setTimeout(IDLE_TIMEOUT, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.once('close', () => client.end());
    client.once('close', () => upstream.destroy());
    if (early.length) upstream.write(early);
    client.pipe(upstream);
    upstream.pipe(client);
    this.emitEntry(conn.entry);
  }

  private open(conn: Conn, kind: ActivityKind, client: string, host: string, port: number): ActivityEntry {
    const entry: ActivityEntry = {
      id: this.nextId++,
      at: Date.now(),
      kind,
      client,
      host,
      port,
      exitId: null,
      direct: false,
      up: 0,
      down: 0,
      status: 'open',
    };
    conn.entry = entry;
    return entry;
  }

  private fail(entry: ActivityEntry, err: unknown) {
    entry.status = 'failed';
    entry.error = err instanceof Error ? err.message : String(err);
  }

  private finish(conn: Conn) {
    this.conns.delete(conn);
    this.closedUp += conn.client.bytesRead;
    this.closedDown += conn.client.bytesWritten;
    const entry = conn.entry;
    if (!entry) return;
    entry.up = conn.client.bytesRead;
    entry.down = conn.client.bytesWritten;
    entry.durationMs = Date.now() - conn.started;
    if (entry.status === 'open') entry.status = 'closed';
    this.emitEntry(entry);
  }

  private emitEntry(entry: ActivityEntry | undefined) {
    if (entry) this.emit('activity', { ...entry });
  }
}

const HOP_BY_HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

function parseHead(text: string): HttpHead | null {
  const lines = text.split('\r\n');
  const [method, target, version] = lines[0].split(' ');
  if (!method || !target || !version?.startsWith('HTTP/')) return null;
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { method: method.toUpperCase(), target, version, headers };
}

function checkBasic(headers: [string, string][], auth: { username: string; password: string }): boolean {
  const value = headers.find(([n]) => n.toLowerCase() === 'proxy-authorization')?.[1];
  if (!value?.toLowerCase().startsWith('basic ')) return false;
  const decoded = Buffer.from(value.slice(6).trim(), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  return safeEqual(decoded.slice(0, idx), auth.username) && safeEqual(decoded.slice(idx + 1), auth.password);
}

const REASONS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function respond(client: net.Socket, status: number, body: string, type = 'text/plain; charset=utf-8', extra: string[] = []) {
  if (client.destroyed) return;
  const payload = Buffer.from(body, 'utf8');
  client.end(
    Buffer.concat([
      Buffer.from(
        [`HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}`, `Content-Type: ${type}`, `Content-Length: ${payload.length}`, 'Connection: close', ...extra].join('\r\n') +
          '\r\n\r\n',
        'latin1',
      ),
      payload,
    ]),
  );
}

function portMessage(err: NodeJS.ErrnoException, port: number, fix: string): string {
  if (err.code === 'EADDRINUSE') return `Port ${port} is already in use by another app. ${fix}`;
  if (err.code === 'EACCES') return `This computer won't let Proxy App use port ${port}. ${fix}`;
  return err.message;
}

function respondAuth(client: net.Socket) {
  respond(client, 407, 'This proxy needs the gateway login set in Proxy App.', undefined, ['Proxy-Authenticate: Basic realm="Proxy App"']);
}

function respondError(client: net.Socket, err: unknown) {
  if (err instanceof GatewayError) return respond(client, err.status, err.message);
  const message = err instanceof Error ? err.message : 'Proxy error';
  const status = err instanceof UpstreamError && err.code === 'timeout' ? 504 : 502;
  respond(client, status, message, undefined, [`X-Proxy-App-Error: ${message.replace(/[^\x20-\x7e]/g, '')}`]);
}

