import type { ProviderDef } from './index';

/**
 * DataImpulse puts targeting in the login: `LOGIN__cr.in;city.mumbai;sessid.abc;sessttl.30`.
 * Port 823 rotates per connection unless `sessid` pins one IP (30 min default,
 * `sessttl` overrides). SOCKS5 is on 824.
 * Docs: https://docs.dataimpulse.com/proxies/parameters/session-id
 */
export const dataImpulse: ProviderDef = {
  id: 'dataimpulse',
  name: 'DataImpulse',

  matches(host) {
    return /(^|\.)dataimpulse\.com$/i.test(host);
  },

  parseLogin(username) {
    const idx = username.indexOf('__');
    if (idx === -1) return { base: username };
    const base = username.slice(0, idx);
    const out: { base: string; country?: string; city?: string } = { base };
    for (const part of username.slice(idx + 2).split(';')) {
      const dot = part.indexOf('.');
      if (dot === -1) continue;
      const key = part.slice(0, dot).toLowerCase();
      const value = part.slice(dot + 1);
      // cr can list several countries ("us,gb"); keep the first, the UI targets one.
      if (key === 'cr' && value) out.country = value.split(',')[0].toLowerCase();
      if (key === 'city' && value) out.city = value.toLowerCase();
    }
    return out;
  },

  buildLogin(base, { country, city, session, sessionMinutes }) {
    const params: string[] = [];
    if (country) params.push(`cr.${country.toLowerCase()}`);
    if (city) params.push(`city.${citySlug(city)}`);
    if (session) params.push(`sessid.${session}`);
    if (session && sessionMinutes) params.push(`sessttl.${Math.round(sessionMinutes)}`);
    return params.length ? `${base}__${params.join(';')}` : base;
  },
};

/** "New York" → "newyork", the form DataImpulse expects. */
export function citySlug(city: string): string {
  return city
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
