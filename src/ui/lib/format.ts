import type { Account, Exit, IpInfo } from '../../shared/types';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n: number): string {
  if (!n) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

export function rate(n: number): string {
  return `${bytes(n)}/s`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const regions = new Intl.DisplayNames(undefined, { type: 'region' });

export function countryName(code: string | undefined): string {
  if (!code) return 'Any country';
  try {
    return regions.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** "Jalandhar, Punjab" — the country is shown by the flag next to it. */
export function placeLine(info: IpInfo | undefined): string {
  if (!info) return '';
  const parts = [info.city, info.region].filter(Boolean) as string[];
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return parts.join(', ') || info.country || '';
}

export function modeLabel(exit: Exit): string {
  if (exit.kind === 'proxy') return 'Fixed proxy';
  if (exit.mode === 'rotating') return 'New IP per connection';
  return exit.sessionMinutes ? `Sticky, ${exit.sessionMinutes} min` : 'Sticky';
}

export function exitCountry(exit: Exit): string | undefined {
  return exit.lastCheck?.info?.countryCode ?? (exit.kind === 'provider' ? exit.country : undefined);
}

export function upstreamHost(exit: Exit, accounts: Account[]): string {
  if (exit.kind === 'proxy') return exit.proxy.host;
  return accounts.find((a) => a.id === exit.accountId)?.host ?? '';
}

export function providerLabel(exit: Exit | undefined, accounts: Account[]): string {
  if (!exit) return 'Provider';
  if (exit.kind === 'proxy') return 'Proxy';
  return accounts.find((a) => a.id === exit.accountId)?.name ?? 'Provider';
}

export const isMacPlatform = (platform: string | undefined) => platform === 'darwin';
