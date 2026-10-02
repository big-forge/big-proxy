import type { ProxySnapshot, SystemProxyDriver } from './index';
import { run } from './run';

// GNOME and most GTK desktops read these keys. Other desktops: set the proxy by hand.
const KEYS: [schema: string, key: string][] = [
  ['org.gnome.system.proxy', 'mode'],
  ['org.gnome.system.proxy', 'ignore-hosts'],
  ['org.gnome.system.proxy.http', 'host'],
  ['org.gnome.system.proxy.http', 'port'],
  ['org.gnome.system.proxy.https', 'host'],
  ['org.gnome.system.proxy.https', 'port'],
  ['org.gnome.system.proxy.socks', 'host'],
  ['org.gnome.system.proxy.socks', 'port'],
];

const gset = (schema: string, key: string, value: string) => run('gsettings', ['set', schema, key, value]);

export const linuxProxy: SystemProxyDriver = {
  async apply(host, port, bypass) {
    const snap: Record<string, string> = {};
    try {
      for (const [schema, key] of KEYS) snap[`${schema} ${key}`] = (await run('gsettings', ['get', schema, key])).trim();
    } catch {
      throw new Error('Automatic proxy setup needs GNOME settings (gsettings). Set the proxy by hand in your desktop settings.');
    }
    for (const kind of ['http', 'https', 'socks']) {
      await gset(`org.gnome.system.proxy.${kind}`, 'host', `'${host}'`);
      await gset(`org.gnome.system.proxy.${kind}`, 'port', String(port));
    }
    await gset('org.gnome.system.proxy', 'ignore-hosts', `[${bypass.map((b) => `'${b}'`).join(', ')}]`);
    await gset('org.gnome.system.proxy', 'mode', "'manual'");
    return { platform: 'linux', data: snap } satisfies ProxySnapshot;
  },

  async restore(snapshot) {
    const snap = snapshot.data as Record<string, string>;
    for (const [schema, key] of KEYS) {
      const value = snap[`${schema} ${key}`];
      if (value !== undefined) await gset(schema, key, value).catch(() => {});
    }
  },
};
