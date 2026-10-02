import type { ProxySnapshot, SystemProxyDriver } from './index';
import { run } from './run';

const KINDS = ['web', 'secureweb', 'socksfirewall'] as const;
type Kind = (typeof KINDS)[number];

interface ProxyValue {
  enabled: boolean;
  server: string;
  port: number;
}

interface ServiceSnapshot {
  service: string;
  proxies: Record<Kind, ProxyValue>;
  bypass: string[];
}

async function services(): Promise<string[]> {
  const out = await run('networksetup', ['-listallnetworkservices']);
  return out
    .split('\n')
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('*'));
}

async function getProxy(service: string, kind: Kind): Promise<ProxyValue> {
  const out = await run('networksetup', [`-get${kind}proxy`, service]);
  const field = (name: string) => out.match(new RegExp(`^${name}: ?(.*)$`, 'm'))?.[1]?.trim() ?? '';
  return { enabled: field('Enabled') === 'Yes', server: field('Server'), port: Number(field('Port')) || 0 };
}

async function getBypass(service: string): Promise<string[]> {
  const out = await run('networksetup', ['-getproxybypassdomains', service]);
  if (/There aren't any/i.test(out)) return [];
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** macOS wants `169.254/16` style; it also accepts plain hosts and wildcards. */
function toMacBypass(entry: string): string {
  const m = entry.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return entry;
  const bits = Number(m[5]);
  const octets = Math.ceil(bits / 8);
  return `${m.slice(1, 1 + Math.max(1, octets)).join('.')}/${bits}`;
}

async function snapshotService(service: string): Promise<ServiceSnapshot> {
  const [web, secureweb, socksfirewall, bypass] = await Promise.all([
    getProxy(service, 'web'),
    getProxy(service, 'secureweb'),
    getProxy(service, 'socksfirewall'),
    getBypass(service),
  ]);
  return { service, proxies: { web, secureweb, socksfirewall }, bypass };
}

export const darwinProxy: SystemProxyDriver = {
  async apply(host, port, bypass) {
    const list = await services();
    const snaps = (await Promise.allSettled(list.map(snapshotService)))
      .filter((r): r is PromiseFulfilledResult<ServiceSnapshot> => r.status === 'fulfilled')
      .map((r) => r.value);
    const results = await Promise.allSettled(
      snaps.map(async ({ service }) => {
        for (const kind of KINDS) await run('networksetup', [`-set${kind}proxy`, service, host, String(port)]);
        await run('networksetup', ['-setproxybypassdomains', service, ...bypass.map(toMacBypass)]);
      }),
    );
    if (snaps.length === 0 || results.every((r) => r.status === 'rejected')) {
      const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
      throw new Error(`Couldn't change the macOS proxy settings${reason ? `: ${reason.message}` : ''}`);
    }
    return { platform: 'darwin', data: snaps } satisfies ProxySnapshot;
  },

  async restore(snapshot) {
    const snaps = snapshot.data as ServiceSnapshot[];
    await Promise.allSettled(
      snaps.map(async ({ service, proxies, bypass }) => {
        for (const kind of KINDS) {
          const prev = proxies[kind];
          if (prev.enabled && prev.server) await run('networksetup', [`-set${kind}proxy`, service, prev.server, String(prev.port)]);
          else await run('networksetup', [`-set${kind}proxystate`, service, 'off']);
        }
        await run('networksetup', ['-setproxybypassdomains', service, ...(bypass.length ? bypass : ['Empty'])]);
      }),
    );
  },
};
