import net from 'node:net';
import os from 'node:os';

export function normalizeAddress(addr: string | undefined): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isLoopback(addr: string): boolean {
  const ip = normalizeAddress(addr);
  if (net.isIPv4(ip)) return inV4Range(ip, '127.0.0.0', 8);
  return ip === '::1';
}

/** Loopback, RFC 1918, link-local, CGNAT (Tailscale lives here) and IPv6 ULA/link-local. */
export function isPrivate(addr: string): boolean {
  const ip = normalizeAddress(addr);
  if (net.isIPv4(ip)) {
    return (
      inV4Range(ip, '127.0.0.0', 8) ||
      inV4Range(ip, '10.0.0.0', 8) ||
      inV4Range(ip, '172.16.0.0', 12) ||
      inV4Range(ip, '192.168.0.0', 16) ||
      inV4Range(ip, '169.254.0.0', 16) ||
      inV4Range(ip, '100.64.0.0', 10)
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  return false;
}

/** Targets that must never go out through a residential exit. */
export function isLocalTarget(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return net.isIP(h) !== 0 && isPrivate(h);
}

export function isLoopbackTarget(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return net.isIP(h) !== 0 && isLoopback(h);
}

export function formatHostPort(host: string, port: number): string {
  return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Parses `host:port`, `[v6]:port`. Returns null when the port is missing or invalid. */
export function parseHostPort(value: string, defaultPort?: number): { host: string; port: number } | null {
  let host: string;
  let portText: string | undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    host = value.slice(1, end);
    portText = value.slice(end + 1).replace(/^:/, '') || undefined;
  } else {
    const idx = value.lastIndexOf(':');
    if (idx === -1) {
      host = value;
    } else {
      host = value.slice(0, idx);
      portText = value.slice(idx + 1);
    }
  }
  const port = portText === undefined ? defaultPort : Number(portText);
  if (!host || port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** IPv4 addresses other devices on the network can use to reach this machine. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal && isPrivate(iface.address) && !iface.address.startsWith('169.254.')) {
        out.push(iface.address);
      }
    }
  }
  // Home Wi-Fi (192.168.x) is what people usually want first.
  return out.sort((a, b) => rank(a) - rank(b));
}

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (ip.startsWith('172.')) return 2;
  return 3;
}
