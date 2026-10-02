import type { Account, Exit, ProviderId, ProxyEndpoint } from '../../shared/types';
import { dataImpulse } from './dataimpulse';

export interface LoginOptions {
  country?: string;
  city?: string;
  /** Present only for sticky exits. */
  session?: string;
  sessionMinutes?: number;
}

export interface ProviderDef {
  id: ProviderId;
  name: string;
  matches(host: string): boolean;
  /** Splits a pasted login into the base login and any targeting inside it. */
  parseLogin(username: string): { base: string; country?: string; city?: string };
  buildLogin(base: string, opts: LoginOptions): string;
}

export const providers: Record<ProviderId, ProviderDef> = {
  dataimpulse: dataImpulse,
};

export function detectProvider(host: string): ProviderDef | null {
  return Object.values(providers).find((p) => p.matches(host)) ?? null;
}

/** The upstream proxy a given exit connects through, or null if its account is gone. */
export function upstreamFor(exit: Exit, accounts: Account[]): ProxyEndpoint | null {
  if (exit.kind === 'proxy') return exit.proxy;
  const account = accounts.find((a) => a.id === exit.accountId);
  if (!account) return null;
  const sticky = exit.mode === 'sticky';
  return {
    protocol: account.protocol,
    host: account.host,
    port: account.port,
    password: account.password,
    username: providers[account.provider].buildLogin(account.username, {
      country: exit.country,
      city: exit.city,
      session: sticky ? exit.session : undefined,
      sessionMinutes: sticky ? exit.sessionMinutes : undefined,
    }),
  };
}
