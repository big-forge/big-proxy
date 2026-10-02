import net from 'node:net';
import tls from 'node:tls';
import type { ProxyEndpoint } from '../shared/types';
import { formatHostPort } from './net-utils';
import { SocketReader } from './socket-reader';

export type UpstreamErrorCode = 'auth' | 'unreachable' | 'timeout' | 'refused' | 'protocol' | 'target';

export class UpstreamError extends Error {
  constructor(
    readonly code: UpstreamErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * Opens a raw TCP tunnel to host:port, through `up` (HTTP CONNECT or SOCKS5),
 * or directly when `up` is null. The returned socket is paused and carries no
 * handshake bytes; pipe it.
 */
export async function openTunnel(
  up: ProxyEndpoint | null,
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<net.Socket> {
  const held: { sock: net.Socket | null } = { sock: null };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      held.sock?.destroy();
      reject(new UpstreamError('timeout', up ? 'The proxy took too long to respond' : `${host} took too long to respond`));
    }, timeoutMs);
  });
  const work = (async () => {
    if (!up) {
      held.sock = await dial(() => net.connect({ host, port }), 'connect', `${formatHostPort(host, port)}`);
      return held.sock;
    }
    const sock = (held.sock = await dial(
      () =>
        up.protocol === 'https'
          ? tls.connect({ host: up.host, port: up.port, servername: net.isIP(up.host) ? undefined : up.host })
          : net.connect({ host: up.host, port: up.port }),
      up.protocol === 'https' ? 'secureConnect' : 'connect',
      `the proxy at ${formatHostPort(up.host, up.port)}`,
    ));
    sock.setNoDelay(true);
    if (up.protocol === 'socks5') await socks5Connect(sock, up, host, port);
    else await httpConnect(sock, up, host, port);
    return sock;
  })();
  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    held.sock?.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Connects to the proxy server itself, without asking it to open a tunnel. */
export async function connectProxy(up: ProxyEndpoint, timeoutMs = DEFAULT_TIMEOUT): Promise<net.Socket> {
  let timer: NodeJS.Timeout | undefined;
  let pending: net.Socket | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      pending?.destroy();
      reject(new UpstreamError('timeout', 'The proxy took too long to respond'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      dial(
        () => {
          pending =
            up.protocol === 'https'
              ? tls.connect({ host: up.host, port: up.port, servername: net.isIP(up.host) ? undefined : up.host })
              : net.connect({ host: up.host, port: up.port });
          return pending;
        },
        up.protocol === 'https' ? 'secureConnect' : 'connect',
        `the proxy at ${formatHostPort(up.host, up.port)}`,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function dial(make: () => net.Socket, readyEvent: string, what: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = make();
    const onError = (err: NodeJS.ErrnoException) => {
      s.destroy();
      reject(socketError(err, what));
    };
    s.once('error', onError);
    s.once(readyEvent, () => {
      s.off('error', onError);
      resolve(s);
    });
  });
}

function socketError(err: NodeJS.ErrnoException, what: string): UpstreamError {
  switch (err.code) {
    case 'ECONNREFUSED':
      return new UpstreamError('refused', `Couldn't connect to ${what} (connection refused)`);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new UpstreamError('unreachable', `Couldn't find ${what}. Check the address and your internet connection.`);
    case 'ETIMEDOUT':
      return new UpstreamError('timeout', `Couldn't reach ${what} (timed out)`);
    case 'ECONNRESET':
      return new UpstreamError('unreachable', `${capitalize(what)} closed the connection`);
    default:
      return new UpstreamError('unreachable', `Couldn't connect to ${what}: ${err.message}`);
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function basicAuth(username?: string, password?: string): string | null {
  if (!username && !password) return null;
  return 'Basic ' + Buffer.from(`${username ?? ''}:${password ?? ''}`, 'utf8').toString('base64');
}

async function httpConnect(sock: net.Socket, up: ProxyEndpoint, host: string, port: number) {
  const target = formatHostPort(host, port);
  const auth = basicAuth(up.username, up.password);
  sock.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
      (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
      'Proxy-Connection: Keep-Alive\r\n\r\n',
  );
  const reader = new SocketReader(sock);
  let head: string;
  try {
    head = (await reader.readUntil('\r\n\r\n', 16 * 1024)).toString('latin1');
  } catch {
    reader.detach();
    throw new UpstreamError('protocol', 'The proxy closed the connection without answering');
  }
  const rest = reader.detach();
  const status = Number(head.split(' ', 3)[1]);
  if (status >= 200 && status < 300) {
    if (rest.length) sock.unshift(rest);
    return;
  }
  throw httpStatusError(status, target);
}

export function httpStatusError(status: number, target: string): UpstreamError {
  if (status === 407) return new UpstreamError('auth', 'The proxy rejected the login. Check the username and password.', status);
  if (status === 403) return new UpstreamError('target', `The proxy blocked ${target}`, status);
  if (status === 502 || status === 503 || status === 504)
    return new UpstreamError('target', `The proxy couldn't reach ${target} (${status})`, status);
  if (!Number.isFinite(status)) return new UpstreamError('protocol', "The proxy didn't answer like an HTTP proxy");
  return new UpstreamError('protocol', `The proxy answered with status ${status}`, status);
}

const SOCKS_REPLY_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

async function socks5Connect(sock: net.Socket, up: ProxyEndpoint, host: string, port: number) {
  const reader = new SocketReader(sock);
  try {
    const wantsAuth = Boolean(up.username || up.password);
    sock.write(Buffer.from(wantsAuth ? [5, 2, 0x00, 0x02] : [5, 1, 0x00]));
    const [ver, method] = await reader.read(2);
    if (ver !== 5) throw new UpstreamError('protocol', "The proxy didn't answer like a SOCKS5 proxy");
    if (method === 0x02) {
      const u = Buffer.from(up.username ?? '', 'utf8');
      const p = Buffer.from(up.password ?? '', 'utf8');
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await reader.read(2);
      if (status !== 0) throw new UpstreamError('auth', 'The proxy rejected the login. Check the username and password.');
    } else if (method === 0xff) {
      throw new UpstreamError('auth', 'The proxy needs a username and password');
    } else if (method !== 0x00) {
      throw new UpstreamError('protocol', 'The proxy asked for an unsupported login method');
    }

    sock.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeSocksAddress(host), portBytes(port)]));
    const [, rep, , atyp] = await reader.read(4);
    if (rep !== 0) {
      throw new UpstreamError('target', `The proxy couldn't reach ${formatHostPort(host, port)} (${SOCKS_REPLY_ERRORS[rep] ?? `error ${rep}`})`);
    }
    if (atyp === 1) await reader.read(4);
    else if (atyp === 4) await reader.read(16);
    else if (atyp === 3) await reader.read((await reader.read(1))[0]);
    else throw new UpstreamError('protocol', 'The proxy sent a malformed SOCKS5 reply');
    await reader.read(2);
  } catch (err) {
    reader.detach();
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError('protocol', 'The proxy closed the connection during the SOCKS5 handshake');
  }
  const rest = reader.detach();
  if (rest.length) sock.unshift(rest);
}

export function portBytes(port: number): Buffer {
  return Buffer.from([(port >> 8) & 0xff, port & 0xff]);
}

export function encodeSocksAddress(host: string): Buffer {
  if (net.isIPv4(host)) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (net.isIPv6(host)) return Buffer.concat([Buffer.from([4]), ipv6ToBytes(host)]);
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) throw new UpstreamError('protocol', 'Host name is too long for SOCKS5');
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

export function ipv6ToBytes(ip: string): Buffer {
  let s = ip.split('%')[0];
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[2].split('.').map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - tail.length - left.length - right.length;
  const groups = [
    ...left.map((h) => parseInt(h, 16)),
    ...(halves.length > 1 ? new Array<number>(Math.max(0, missing)).fill(0) : []),
    ...right.map((h) => parseInt(h, 16)),
    ...tail,
  ];
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(g & 0xffff, i * 2));
  return out;
}
