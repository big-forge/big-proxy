import type { ProxySnapshot, SystemProxyDriver } from './index';
import { run } from './run';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'] as const;
type Name = (typeof VALUES)[number];
type Snapshot = Record<Name, string | null>;

async function query(name: Name): Promise<string | null> {
  try {
    const out = await run('reg', ['query', KEY, '/v', name]);
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s*(.*)`));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function write(name: Name, value: string | null) {
  if (value === null) {
    await run('reg', ['delete', KEY, '/v', name, '/f']).catch(() => {});
  } else if (name === 'ProxyEnable') {
    await run('reg', ['add', KEY, '/v', name, '/t', 'REG_DWORD', '/d', String(parseInt(value, value.startsWith('0x') ? 16 : 10) || 0), '/f']);
  } else {
    await run('reg', ['add', KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
  }
}

/** Tells WinINet (and so Edge, Chrome and most apps) to re-read the settings now. */
async function refresh() {
  const script = [
    "$sig = '[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);'",
    '$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace ProxyApp -PassThru',
    '[void]$t::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0)',
    '[void]$t::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0)',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]).catch(() => {});
}

/** Windows bypass entries use wildcards, not CIDR. */
export function toWindowsBypass(list: string[]): string {
  const out: string[] = [];
  for (const entry of list) {
    const m = entry.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    if (!m) {
      if (entry !== '::1') out.push(entry);
      continue;
    }
    const [a, b, c] = [m[1], m[2], m[3]];
    const bits = Number(m[5]);
    if (bits === 12 && a === '172') for (let i = 16; i < 32; i++) out.push(`172.${i}.*`);
    else if (bits <= 8) out.push(`${a}.*`);
    else if (bits <= 16) out.push(`${a}.${b}.*`);
    else out.push(`${a}.${b}.${c}.*`);
  }
  out.push('<local>');
  return [...new Set(out)].join(';');
}

export const windowsProxy: SystemProxyDriver = {
  async apply(host, port, bypass) {
    const snap = {} as Snapshot;
    for (const name of VALUES) snap[name] = await query(name);
    await write('ProxyServer', `${host}:${port}`);
    await write('ProxyOverride', toWindowsBypass(bypass));
    await write('ProxyEnable', '1');
    // An auto-config script would take priority over the manual proxy.
    await write('AutoConfigURL', null);
    await refresh();
    return { platform: 'win32', data: snap } satisfies ProxySnapshot;
  },

  async restore(snapshot) {
    const snap = snapshot.data as Snapshot;
    for (const name of VALUES) await write(name, snap[name]);
    if (snap.ProxyEnable === null) await write('ProxyEnable', '0');
    await refresh();
  },
};
