import type {
  Account,
  ActivityEntry,
  AddProxiesInput,
  AppState,
  BrowserId,
  BrowserProfile,
  CreateExitsInput,
  InstalledApp,
  ExitCheck,
  ExitMode,
  ProxyEndpoint,
  Settings,
  TestProxyInput,
  TestProxyResult,
} from '../../shared/types';

/** Injected into index.html by the control server; Vite's proxy adds it in dev. */
export const token = document.querySelector<HTMLMetaElement>('meta[name="proxy-app-token"]')?.content ?? '';

let onState: ((s: AppState) => void) | null = null;
export function setStateSink(fn: (s: AppState) => void) {
  onState = fn;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-proxy-app-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the Proxy App service. Is it still running?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  // Most actions answer with the new state; apply it right away instead of waiting for the stream.
  if (data && typeof data === 'object' && 'exits' in data && 'settings' in data) onState?.(data as AppState);
  else if (data?.state) onState?.(data.state as AppState);
  return data as T;
}

type ExitPatch = Partial<{ name: string; mode: ExitMode; country: string; city: string; sessionMinutes: number | null; proxy: Partial<ProxyEndpoint>; port: number }>;

export const api = {
  connect: () => call<AppState>('POST', '/api/connect'),
  disconnect: () => call<AppState>('POST', '/api/disconnect'),
  activate: (id: string) => call<AppState>('POST', `/api/exits/${id}/activate`),
  exitUrl: (id: string) => call<{ url: string }>('GET', `/api/exits/${id}/url`),
  rotate: (id: string) => call<ExitCheck>('POST', `/api/exits/${id}/rotate`),
  check: (id: string) => call<ExitCheck>('POST', `/api/exits/${id}/check`),
  checkAll: () => call<AppState>('POST', '/api/exits/check-all'),
  addProxies: (input: AddProxiesInput) => call<{ created: number; invalid: string[]; state: AppState }>('POST', '/api/proxies', input),
  testProxy: (input: TestProxyInput) => call<TestProxyResult>('POST', '/api/proxies/test', input),
  createExits: (input: CreateExitsInput) => call<{ created: number; state: AppState }>('POST', '/api/exits', input),
  updateExit: (id: string, patch: ExitPatch) => call<AppState>('PATCH', `/api/exits/${id}`, patch),
  deleteExit: (id: string) => call<AppState>('DELETE', `/api/exits/${id}`),
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'username' | 'password' | 'host' | 'port' | 'protocol'>>) =>
    call<AppState>('PATCH', `/api/accounts/${id}`, patch),
  deleteAccount: (id: string) => call<AppState>('DELETE', `/api/accounts/${id}`),
  updateSettings: (patch: Partial<Settings>) => call<AppState>('PATCH', '/api/settings', patch),
  activity: () => call<ActivityEntry[]>('GET', '/api/activity'),
  clearActivity: () => call<{ ok: true }>('DELETE', '/api/activity'),
  resetUsage: () => call<AppState>('POST', '/api/usage/reset'),
  browsers: () => call<BrowserProfile[]>('GET', '/api/browsers'),
  openBrowser: (browser: BrowserId, dir: string) => call<{ ok: true }>('POST', '/api/browsers/open', { browser, dir }),
  revealExtension: () => call<{ ok: true }>('POST', '/api/extension/reveal'),
  firefoxProxy: (dir: string, enabled: boolean) => call<{ ok: true }>('POST', '/api/browsers/firefox', { dir, enabled }),
  profileProxy: (browser: BrowserId, dir: string, enabled: boolean, exitId: string | null) =>
    call<{ ok: boolean; restarted: boolean; needsQuit: boolean }>('POST', '/api/browsers/proxy', { browser, dir, enabled, exitId }),
  apps: (refresh = false) => call<InstalledApp[]>('GET', `/api/apps${refresh ? '?refresh' : ''}`),
  appProxy: (id: string, enabled: boolean, exitId: string | null) =>
    call<{ restarted: boolean; needsQuit: boolean; state: AppState }>('POST', '/api/apps/proxy', { id, enabled, exitId }),
  openApp: (id: string) => call<{ restarted: boolean; needsQuit: boolean; state: AppState }>('POST', '/api/apps/open', { id }),
  shell: (action: 'updateCheck' | 'updateInstall' | 'updatePage') => call<{ ok: true }>('POST', `/api/shell/${action}`),
  openTerminal: (exitId: string | null) => call<{ ok: true }>('POST', '/api/terminal', { exitId }),
  appIconUrl: (id: string) => `/api/apps/icon?id=${encodeURIComponent(id)}${token ? `&token=${encodeURIComponent(token)}` : ''}`,
};
