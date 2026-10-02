import type net from 'node:net';
import tls from 'node:tls';
import type { ExitCheck, IpInfo, ProxyEndpoint } from '../shared/types';
import { openTunnel, UpstreamError } from './upstream';

const TIMEOUT = 8_000;

/**
 * Finds out which public IP an upstream exits from, and where that IP is.
 * Runs straight through the upstream, not the local gateway, so it works
 * while disconnected and never touches other traffic.
 */
export async function checkUpstream(up: ProxyEndpoint): Promise<ExitCheck> {
  const at = Date.now();
  let latencyMs: number | undefined;
  try {
    const t0 = performance.now();
    const sock = await openTunnel(up, 'ip-api.com', 80, TIMEOUT);
    latencyMs = Math.round(performance.now() - t0);
    const body = await httpGet(sock, 'ip-api.com', '/json/?fields=status,message,country,countryCode,regionName,city,isp,query');
    const j = JSON.parse(body);
    if (j.status !== 'success' || !j.query) throw new Error(j.message || 'IP lookup failed');
    return { at, ok: true, latencyMs, info: clean({ ip: j.query, countryCode: j.countryCode, country: j.country, region: j.regionName, city: j.city, isp: j.isp }) };
  } catch (err) {
    // Login or connection problems won't get better with a second lookup service.
    if (err instanceof UpstreamError && err.code !== 'target' && err.code !== 'protocol') {
      return { at, ok: false, error: err.message, errorCode: err.code };
    }
  }
  try {
    const t0 = performance.now();
    const raw = await openTunnel(up, 'ipwho.is', 443, TIMEOUT);
    latencyMs ??= Math.round(performance.now() - t0);
    const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: raw, servername: 'ipwho.is' }, () => resolve(s));
      s.once('error', reject);
    });
    const body = await httpGet(sock, 'ipwho.is', '/?fields=success,message,ip,country,country_code,region,city,connection');
    const j = JSON.parse(body);
    if (j.success === false || !j.ip) throw new Error(j.message || 'IP lookup failed');
    return {
      at,
      ok: true,
      latencyMs,
      info: clean({ ip: j.ip, countryCode: j.country_code, country: j.country, region: j.region, city: j.city, isp: j.connection?.isp || j.connection?.org }),
    };
  } catch (err) {
    return {
      at,
      ok: false,
      error: err instanceof Error ? err.message : 'IP lookup failed',
      errorCode: err instanceof UpstreamError ? err.code : 'lookup',
    };
  }
}

function clean(info: IpInfo): IpInfo {
  const out: IpInfo = { ip: info.ip };
  for (const key of ['countryCode', 'country', 'region', 'city', 'isp'] as const) {
    const v = info[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  if (out.countryCode) out.countryCode = out.countryCode.toUpperCase();
  return out;
}

function httpGet(sock: net.Socket | tls.TLSSocket, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`${host} took too long to answer`));
    }, TIMEOUT);
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const status = Number(text.split(' ', 3)[1]);
      if (split === -1 || status !== 200) reject(new Error(`${host} answered with status ${status || 'unknown'}`));
      else resolve(text.slice(split + 4));
    });
    sock.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nUser-Agent: ProxyApp/1\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    sock.resume();
  });
}
