import type { ParsedProxy, ProxyProtocol } from '../shared/types';
import { detectProvider } from './providers';

const SCHEMES: Record<string, ProxyProtocol> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
};

function isPort(value: string | undefined): boolean {
  if (!value || !/^\d{1,5}$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts the formats vendors hand out:
 *   scheme://user:pass@host:port   user:pass@host:port
 *   host:port:user:pass            user:pass:host:port   host:port
 */
export function parseProxyLine(raw: string): ParsedProxy | null {
  let line = raw.trim();
  if (!line || line.startsWith('#')) return null;

  let protocol: ProxyProtocol = 'http';
  const scheme = line.match(/^([a-z0-9]+):\/\//i);
  if (scheme) {
    const p = SCHEMES[scheme[1].toLowerCase()];
    if (!p) return null;
    protocol = p;
    line = line.slice(scheme[0].length);
  }
  line = line.replace(/\/+$/, '');

  let host: string;
  let portText: string;
  let username = '';
  let password = '';

  const at = line.lastIndexOf('@');
  if (at !== -1) {
    const cred = line.slice(0, at);
    const ci = cred.indexOf(':');
    username = decode(ci === -1 ? cred : cred.slice(0, ci));
    password = decode(ci === -1 ? '' : cred.slice(ci + 1));
    const hp = line.slice(at + 1);
    const pi = hp.lastIndexOf(':');
    if (pi === -1) return null;
    host = hp.slice(0, pi);
    portText = hp.slice(pi + 1);
  } else {
    const parts = line.split(':');
    if (parts.length === 2) {
      [host, portText] = parts;
    } else if (parts.length >= 4 && isPort(parts[1])) {
      host = parts[0];
      portText = parts[1];
      username = parts[2];
      password = parts.slice(3).join(':');
    } else if (parts.length === 4 && isPort(parts[3])) {
      [username, password, host, portText] = parts;
    } else {
      return null;
    }
  }

  host = host.replace(/^\[|\]$/g, '').trim();
  if (!host || !isPort(portText)) return null;

  const parsed: ParsedProxy = { protocol, host, port: Number(portText), username, password, provider: null };
  const provider = detectProvider(host);
  if (provider) {
    const login = provider.parseLogin(username);
    parsed.provider = provider.id;
    parsed.username = login.base;
    parsed.country = login.country;
    parsed.city = login.city;
  }
  return parsed;
}

export function parseProxyList(text: string): { parsed: ParsedProxy[]; invalid: string[] } {
  const parsed: ParsedProxy[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const p = parseProxyLine(trimmed);
    if (p) parsed.push(p);
    else invalid.push(trimmed);
  }
  return { parsed, invalid };
}
