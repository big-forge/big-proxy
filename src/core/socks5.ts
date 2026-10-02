import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { SocketReader } from './socket-reader';
import { UpstreamError } from './upstream';
import { safeEqual } from './secure';

export interface SocksTarget {
  host: string;
  port: number;
}

export class SocksAuthError extends Error {}

/**
 * Server side of a SOCKS5 handshake. The version byte has already been
 * consumed by the protocol sniffer. Only CONNECT is supported.
 */
export async function acceptSocks5(
  sock: Duplex,
  reader: SocketReader,
  auth: { username: string; password: string } | null,
): Promise<SocksTarget> {
  const [nmethods] = await reader.read(1);
  const methods = [...(await reader.read(nmethods))];

  if (auth) {
    if (!methods.includes(0x02)) {
      sock.end(Buffer.from([5, 0xff]));
      throw new SocksAuthError('Client did not offer a login');
    }
    sock.write(Buffer.from([5, 0x02]));
    const ok = await readCredentials(reader, (u, p) => safeEqual(u, auth.username) && safeEqual(p, auth.password));
    sock.write(Buffer.from([1, ok ? 0 : 1]));
    if (!ok) {
      sock.end();
      throw new SocksAuthError('Wrong gateway login');
    }
  } else if (methods.includes(0x00)) {
    sock.write(Buffer.from([5, 0x00]));
  } else if (methods.includes(0x02)) {
    // Some clients always send a login. No login is required here, so accept any.
    sock.write(Buffer.from([5, 0x02]));
    await readCredentials(reader, () => true);
    sock.write(Buffer.from([1, 0]));
  } else {
    sock.end(Buffer.from([5, 0xff]));
    throw new SocksAuthError('No supported login method');
  }

  const [ver, cmd, , atyp] = await reader.read(4);
  if (ver !== 5) throw new Error('Bad SOCKS5 request');
  let host: string;
  if (atyp === 1) {
    host = [...(await reader.read(4))].join('.');
  } else if (atyp === 3) {
    const [len] = await reader.read(1);
    host = (await reader.read(len)).toString('utf8');
  } else if (atyp === 4) {
    const b = await reader.read(16);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
    host = net.isIPv6(groups.join(':')) ? groups.join(':') : '::';
  } else {
    socksReply(sock, 8);
    throw new Error('Unsupported SOCKS5 address type');
  }
  const portBuf = await reader.read(2);
  const port = portBuf.readUInt16BE(0);
  if (cmd !== 1) {
    socksReply(sock, 7);
    throw new Error('Only SOCKS5 CONNECT is supported');
  }
  return { host, port };
}

async function readCredentials(reader: SocketReader, check: (u: string, p: string) => boolean): Promise<boolean> {
  const [, ulen] = await reader.read(2);
  const user = (await reader.read(ulen)).toString('utf8');
  const [plen] = await reader.read(1);
  const pass = (await reader.read(plen)).toString('utf8');
  return check(user, pass);
}

export function socksReply(sock: Duplex, rep: number) {
  sock.write(Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]));
}

export function socksReplyFor(err: unknown): number {
  if (!(err instanceof UpstreamError)) return 1;
  switch (err.code) {
    case 'refused':
      return 5;
    case 'unreachable':
    case 'target':
    case 'timeout':
      return 4;
    case 'auth':
      return 2;
    default:
      return 1;
  }
}
