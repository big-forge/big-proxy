import { Check, ChevronRight, CircleCheck, Copy, FolderOpen, Search, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState, BrowserProfile, InstalledApp } from '../../shared/types';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Flag } from '../components/Flag';
import { Select } from '../components/Select';
import { toast, toastError } from '../components/Toaster';
import { Button, IconButton, Input, Notice, PageHeader, Panel, Skeleton, Switch, cx } from '../components/ui';
import { api } from '../lib/api';
import { exitCountry } from '../lib/format';

const EXTENSION_PAGES: Record<string, string> = { chrome: 'chrome://extensions', edge: 'edge://extensions', brave: 'brave://extensions', chromium: 'chrome://extensions' };
const FOLLOW = 'follow';

/** Polls a list while the view is open; apps open and close, profiles gain the extension. */
function usePoll<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () =>
      load().then(
        (d) => alive && (setData(d), setError(null)),
        (e) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    run();
    const t = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

const profileKey = (p: BrowserProfile) => `${p.browser}/${p.dir}`;

function CopyText({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex min-w-0 items-center gap-1 rounded-sm border border-line bg-sunken py-0.5 pr-0.5 pl-2.5">
      <span className={cx('min-w-0 flex-1 truncate text-[13px] text-ink', mono && 'font-mono')} title={value}>
        {value}
      </span>
      <IconButton
        label={copied ? 'Copied' : `Copy ${label}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="text-fiber-text" /> : <Copy />}
      </IconButton>
    </span>
  );
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

function AppIcon({ app, size = 28 }: { app: InstalledApp; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span aria-hidden style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-[7px] bg-hover text-[11px] font-semibold text-ink-2">
        {initials(app.name)}
      </span>
    );
  }
  return <img src={api.appIconUrl(app.id)} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className="shrink-0" />;
}

function Section({ id, title, aside, children, note }: { id: string; title: string; aside?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="mt-8" aria-labelledby={id}>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 id={id} className="text-[13px] font-semibold text-ink-2">
          {title}
        </h2>
        {aside && <span className="text-[12px] text-ink-3 tabular-nums">{aside}</span>}
      </div>
      <Panel className="overflow-hidden">{children}</Panel>
      {note && <p className="mt-2 text-[12px] text-ink-3">{note}</p>}
    </section>
  );
}

export function AppsView({ state }: { state: AppState }) {
  const profiles = usePoll(api.browsers, 4000);
  const apps = usePoll(() => api.apps(), 5000);
  const [query, setQuery] = useState('');
  const [setup, setSetup] = useState<BrowserProfile | null>(null);
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);

  const groups = useMemo(() => {
    const list = apps.data ?? [];
    return {
      launch: list.filter((a) => a.method === 'launch' && match(a.name)),
      inside: list.filter((a) => a.method === 'inside' && match(a.name)),
      system: list.filter((a) => a.method === 'system' && match(a.name)),
    };
  }, [apps.data, q]);
  const shownProfiles = (profiles.data ?? []).filter((p) => match(p.name) || match(p.browserName) || (p.email && match(p.email)));
  const browsers = [...new Set((profiles.data ?? []).map((p) => p.browserName))];
  const usingProfiles = (profiles.data ?? []).filter((p) => p.extension === 'on' || p.proxyPort !== null).length;
  const usingApps = (apps.data ?? []).filter((a) => a.rule).length;
  const off = state.status !== 'on';

  return (
    <div className="mx-auto max-w-[880px] px-4 py-6 sm:px-6">
      <PageHeader
        title="Choose what uses the proxy"
        description="Only what you turn on here uses your proxy data. Everything else on this computer keeps your normal connection."
      />

      <Panel className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">This whole computer</div>
          <p className="mt-0.5 text-[13px] text-ink-3">Every app, update and sync goes through the proxy. Uses the most data; leave it off and pick apps below.</p>
        </div>
        <Switch label="Route this whole computer" checked={state.settings.systemProxy} onChange={(systemProxy) => api.updateSettings({ systemProxy }).catch(toastError)} />
      </Panel>

      {off && (usingApps > 0 || usingProfiles > 0) && (
        <div className="mt-4">
          <Notice tone="info" action={<a href="#connect" className="shrink-0 font-medium underline underline-offset-2">Connect</a>}>
            Proxy App is off, so the apps and profiles you turned on can't load anything right now.
          </Notice>
        </div>
      )}

      <div className="relative mt-6">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <Input aria-label="Search apps and profiles" placeholder="Search apps and profiles" value={query} onChange={(e) => setQuery(e.target.value)} className="h-10 pl-9" />
      </div>

      <Section
        id="profiles-heading"
        title="Browser profiles"
        aside={profiles.data && profiles.data.length > 0 ? `${usingProfiles} of ${profiles.data.length} use the proxy` : undefined}
        note="Switch on a profile and Proxy App sets it up for you. Only that profile uses the proxy, and each one can have its own IP. Add the toolbar button to connect, disconnect and get a new IP from inside the browser."
      >
        {profiles.error ? (
          <div className="p-4">
            <Notice tone="error">{profiles.error}</Notice>
          </div>
        ) : !profiles.data ? (
          <ListSkeleton />
        ) : shownProfiles.length === 0 ? (
          <Empty>{q ? 'No profile matches that search.' : 'No Chrome, Edge, Brave or Firefox profiles found.'}</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {shownProfiles.map((p) => (
              <ProfileRow key={profileKey(p)} profile={p} state={state} showBrowser={browsers.length > 1} onSetup={() => setSetup(p)} onChanged={profiles.reload} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="apps-heading"
        title="Apps"
        aside={apps.data ? `${usingApps} use the proxy` : undefined}
        note="These apps read the proxy when they start, so Proxy App reopens them when you switch one on. Opening one from the Dock or Start menu later starts it without the proxy; open it from here instead."
      >
        <ul className="divide-y divide-line">
          {match('terminal') && <TerminalRow state={state} />}
          {apps.error ? (
            <li className="p-4">
              <Notice tone="error">{apps.error}</Notice>
            </li>
          ) : !apps.data ? (
            <li>
              <ListSkeleton />
            </li>
          ) : (
            groups.launch.map((a) => <AppRow key={a.id} app={a} state={state} onChanged={apps.reload} />)
          )}
        </ul>
      </Section>

      {groups.inside.length > 0 && (
        <Section id="inside-heading" title="Set the proxy inside these apps" note="They have their own proxy setting, which works better than restarting them.">
          <ul className="divide-y divide-line">
            {groups.inside.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <AppIcon app={a} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{a.name}</div>
                  <p className="mt-0.5 text-[12px] text-ink-3">{a.hint}</p>
                </div>
                <div className="hidden w-[190px] shrink-0 sm:block">
                  <CopyText value={`127.0.0.1:${state.settings.gatewayPort}`} label="address" />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {groups.system.length > 0 && <SystemOnly apps={groups.system} />}

      <Section
        id="ports-heading"
        title="Fixed address for each IP"
        note="For apps with a proxy setting, antidetect browsers and scripts. They work as HTTP or SOCKS5 proxies while Proxy App is connected, and never change IP when you switch."
      >
        <ul className="divide-y divide-line">
          <li className="grid items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_240px]">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">Follows the app</div>
              <div className="text-[12px] text-ink-3">Changes IP whenever you switch.</div>
            </div>
            <CopyText value={`127.0.0.1:${state.settings.gatewayPort}`} label="address" />
          </li>
          {state.exits.map((e) => (
            <li key={e.id} className="grid items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_240px]">
              <div className="flex min-w-0 items-center gap-3">
                <Flag code={exitCountry(e)} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{e.name}</div>
                  <div className={cx('truncate text-[12px]', state.pinnedErrors[e.id] ? 'text-danger' : 'text-ink-3')}>
                    {state.pinnedErrors[e.id] ?? (e.lastCheck?.info?.ip ? `Always ${e.lastCheck.info.ip}` : 'Always this IP')}
                  </div>
                </div>
              </div>
              {e.port ? <CopyText value={`127.0.0.1:${e.port}`} label={`address for ${e.name}`} /> : null}
            </li>
          ))}
        </ul>
      </Section>

      {setup && (
        <SetupDialog
          profile={(profiles.data ?? []).find((p) => profileKey(p) === profileKey(setup)) ?? setup}
          extensionDir={state.extensionDir}
          platform={state.platform}
          onClose={() => setSetup(null)}
        />
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-[13px] text-ink-3">{children}</p>;
}

function IpSelect({ state, value, onChange, label }: { state: AppState; value: string | null; onChange: (exitId: string | null) => void; label: string }) {
  return (
    <div className="w-40 shrink-0">
      <Select
        label={label}
        value={value ?? FOLLOW}
        onChange={(v) => onChange(v === FOLLOW ? null : v)}
        options={[{ value: FOLLOW, label: 'Follows the app' }, ...state.exits.map((e) => ({ value: e.id, label: e.name }))]}
        className="h-8 text-[13px]"
      />
    </div>
  );
}

function TerminalRow({ state }: { state: AppState }) {
  const [exitId, setExitId] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-hover text-ink-2">
        <SquareTerminal className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">Terminal</div>
        <div className="text-[12px] text-ink-3">A new window where commands and scripts (curl, Python, Node) use the proxy.</div>
      </div>
      <IpSelect state={state} value={exitId} onChange={setExitId} label="IP for the terminal" />
      <Button size="sm" onClick={() => api.openTerminal(exitId).catch(toastError)}>
        Open terminal
      </Button>
    </li>
  );
}

function AppRow({ app, state, onChanged }: { app: InstalledApp; state: AppState; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ enabled: boolean; exitId: string | null } | null>(null);
  const rule = app.rule;
  const exitPort = (exitId: string | null) => (exitId ? state.exits.find((e) => e.id === exitId)?.port : undefined) ?? state.settings.gatewayPort;
  const expected = rule ? exitPort(rule.exitId) : null;
  const exitName = rule?.exitId ? state.exits.find((e) => e.id === rule.exitId)?.name : null;

  const apply = async (enabled: boolean, exitId: string | null) => {
    setBusy(app.running ? 'Restarting' : 'Saving');
    try {
      const res = await api.appProxy(app.id, enabled, exitId);
      if (res.needsQuit) toast(`${app.name} didn't close. Quit it yourself, then click Open.`, 'error');
      else if (res.restarted) toast(enabled ? `${app.name} reopened with the proxy` : `${app.name} reopened with your normal connection`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const request = (enabled: boolean, exitId: string | null) => (app.running ? setConfirm({ enabled, exitId }) : void apply(enabled, exitId));
  const open = async () => {
    setBusy('Opening');
    try {
      const res = await api.openApp(app.id);
      if (res.needsQuit) toast(`${app.name} didn't close. Quit it yourself, then click Open.`, 'error');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
      setTimeout(onChanged, 1500);
    }
  };

  let status: ReactNode;
  if (busy) status = <span className="text-ink-3">{busy}…</span>;
  else if (rule && app.running && app.proxyPort === expected) status = <span className="text-fiber-text">Using the proxy{exitName ? `: ${exitName}` : ''}</span>;
  else if (rule && app.running) status = <span className="text-amber">Open without the proxy</span>;
  else if (rule) status = <span className="text-ink-3">Uses the proxy when opened from here</span>;
  else if (app.running && app.proxyPort) status = <span className="text-amber">Still on the proxy until it restarts</span>;
  else status = <span className="text-ink-3">{app.running ? 'Open, normal connection' : 'Normal connection'}</span>;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <AppIcon app={app} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{app.name}</div>
        <div className="truncate text-[12px]">{status}</div>
      </div>
      {rule && !busy && (!app.running || app.proxyPort !== expected) && (
        <Button size="sm" variant="ghost" onClick={open}>
          {app.running ? 'Restart with proxy' : 'Open'}
        </Button>
      )}
      {rule && <IpSelect state={state} value={rule.exitId} onChange={(exitId) => request(true, exitId)} label={`IP for ${app.name}`} />}
      <Switch label={`Use the proxy for ${app.name}`} checked={Boolean(rule)} disabled={Boolean(busy)} onChange={(v) => request(v, rule?.exitId ?? null)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={`Restart ${app.name}?`}
        description={`${app.name} closes and opens again ${confirm?.enabled ? 'with the proxy' : 'with your normal connection'}. Save any work in it first.`}
        confirmLabel={`Restart ${app.name}`}
        onConfirm={async () => {
          if (confirm) await apply(confirm.enabled, confirm.exitId);
        }}
      />
    </li>
  );
}

function SystemOnly({ apps }: { apps: InstalledApp[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-8" aria-labelledby="system-heading">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex w-full items-center justify-between gap-4 rounded-sm text-left"
      >
        <h2 id="system-heading" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
          <ChevronRight className={cx('size-4 transition-transform duration-150', open && 'rotate-90')} aria-hidden />
          Only with “This whole computer”
        </h2>
        <span className="text-[12px] text-ink-3 tabular-nums">{apps.length} apps</span>
      </button>
      {open && (
        <Panel className="p-4">
          <p className="mb-4 text-[13px] text-ink-3">
            These use your system’s own networking and have no proxy setting, so Proxy App can only reach them by routing the whole computer. Sending just one of them through a
            proxy needs a system network extension, which isn’t built yet.
          </p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
            {apps.map((a) => (
              <li key={a.id} className="flex min-w-0 items-center gap-2.5">
                <AppIcon app={a} size={22} />
                <span className="truncate text-[13px] text-ink-2">{a.name}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}

function ProfileRow({
  profile,
  state,
  showBrowser,
  onSetup,
  onChanged,
}: {
  profile: BrowserProfile;
  state: AppState;
  showBrowser: boolean;
  onSetup: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ enabled: boolean; exitId: string | null } | null>(null);
  const button = profile.extension === 'on';
  const firefox = profile.kind === 'prefs';
  const port = profile.proxyPort;
  const exitForPort = port !== null && port !== state.settings.gatewayPort ? state.exits.find((e) => e.port === port) : undefined;
  const ours = port !== null && (port === state.settings.gatewayPort || exitForPort !== undefined);
  const on = button || (firefox ? profile.extension === 'on' : port !== null);

  const apply = async (enabled: boolean, exitId: string | null) => {
    setBusy(true);
    try {
      if (firefox) {
        await api.firefoxProxy(profile.dir, enabled);
        toast(`Saved. Restart Firefox to ${enabled ? 'use the proxy in' : 'turn the proxy off for'} ${profile.name}.`);
      } else {
        const res = await api.profileProxy(profile.browser, profile.dir, enabled, exitId);
        if (res.needsQuit) toast(`${profile.browserName} didn't close. Quit it yourself, then switch again.`, 'error');
        else toast(enabled ? `${profile.name} now uses the proxy${res.restarted ? `. ${profile.browserName} reopened with your tabs.` : '.'}` : `${profile.name} is back on your normal connection.`);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const request = (enabled: boolean, exitId: string | null) => (!firefox && profile.running ? setConfirm({ enabled, exitId }) : void apply(enabled, exitId));

  let status: ReactNode;
  if (busy) status = <span className="text-ink-3">{profile.running && !firefox ? `Restarting ${profile.browserName}…` : 'Saving…'}</span>;
  else if (button) status = <span className="text-fiber-text">Proxy App button: control it from the toolbar</span>;
  else if (firefox) status = <span className={on ? 'text-fiber-text' : 'text-ink-3'}>{on ? 'Uses the proxy' : 'Normal connection'}</span>;
  else if (port !== null && !ours) status = <span className="text-amber">Points at an old address. Switch off and on again.</span>;
  else if (port !== null) status = <span className="text-fiber-text">Uses the proxy{exitForPort ? `: ${exitForPort.name}` : ', follows the app'}</span>;
  else status = <span className="text-ink-3">Normal connection</span>;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span
        aria-hidden
        className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold', on ? 'bg-fiber-soft text-fiber-text' : 'bg-hover text-ink-2')}
      >
        {initials(profile.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">
          {profile.name}
          {showBrowser && <span className="ml-2 font-normal text-ink-3">{profile.browserName}</span>}
        </div>
        <div className="truncate text-[12px]">
          <span className="text-ink-3">{profile.email ?? (firefox ? 'Firefox profile' : profile.dir)}</span>
        </div>
        <div className="truncate text-[12px]">{status}</div>
      </div>
      {button ? (
        <Button size="sm" variant="ghost" onClick={() => api.openBrowser(profile.browser, profile.dir).catch(toastError)}>
          Open
        </Button>
      ) : (
        <>
          {!firefox && (
            <Button size="sm" variant="ghost" onClick={onSetup}>
              Add button
            </Button>
          )}
          {!firefox && port !== null && ours && (
            <IpSelect state={state} value={exitForPort?.id ?? null} onChange={(exitId) => request(true, exitId)} label={`IP for ${profile.name}`} />
          )}
          <Switch label={`Use the proxy in ${profile.name}`} checked={on} disabled={busy} onChange={(v) => request(v, exitForPort?.id ?? null)} />
        </>
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={`Restart ${profile.browserName}?`}
        description={`${profile.browserName} closes and reopens with your tabs so “${profile.name}” can ${confirm?.enabled ? 'use the proxy' : 'go back to your normal connection'}. Other profiles are not changed.`}
        confirmLabel={`Restart ${profile.browserName}`}
        onConfirm={async () => {
          if (confirm) await apply(confirm.enabled, confirm.exitId);
        }}
      />
    </li>
  );
}

function SetupDialog({ profile, extensionDir, platform, onClose }: { profile: BrowserProfile; extensionDir: string; platform: string; onClose: () => void }) {
  const done = profile.extension === 'on';
  const page = EXTENSION_PAGES[profile.browser] ?? EXTENSION_PAGES.chrome;
  const mac = platform === 'darwin';
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Add the Proxy App button to “${profile.name}”`}
      description={`Optional. Lets you connect, disconnect and get a new IP from inside ${profile.browserName}, without restarting it. Only this profile is affected.`}
      width={580}
    >
      <ol className="flex flex-col gap-5">
        <Step n={1} title={`Open the profile in ${profile.browserName}`}>
          <Button variant="primary" size="sm" className="mt-2" onClick={() => api.openBrowser(profile.browser, profile.dir).catch(toastError)}>
            Open {profile.name}
          </Button>
          <p className="mt-1.5 text-[12px] text-ink-3">A window opens with these same steps, so you can follow along there.</p>
        </Step>
        <Step n={2} title="Go to the extensions page and turn on Developer mode">
          <div className="mt-2 max-w-72">
            <CopyText value={page} label="extensions page address" />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">Paste it in the address bar. Developer mode is the switch in the top-right corner.</p>
        </Step>
        <Step n={3} title="Click Load unpacked and choose this folder">
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <CopyText value={extensionDir} label="folder path" />
            </div>
            <Button size="sm" variant="ghost" onClick={() => api.revealExtension().catch(toastError)}>
              <FolderOpen aria-hidden />
              Show folder
            </Button>
          </div>
          <p className="mt-1.5 text-[12px] text-ink-3">
            {mac ? 'In the folder picker press ⌘ ⇧ G, paste the path, then click Select.' : 'Paste the path into the folder picker’s address bar, then click Select Folder.'}
          </p>
        </Step>
        <Step n={4} title="Pin Proxy App and pick the IP for this profile">
          <p className="mt-1 text-[13px] text-ink-3">Click the puzzle icon in the toolbar, pin Proxy App, then click it. “Same as the app” follows your switching here.</p>
        </Step>
      </ol>
      <div className="mt-6 border-t border-line pt-4" aria-live="polite">
        {done ? (
          <p className="flex items-center gap-2 text-[13px] font-medium text-fiber-text">
            <CircleCheck className="size-4" aria-hidden /> Done. {profile.name} now uses the proxy.
          </p>
        ) : (
          <p className="text-[13px] text-ink-3">Waiting for the extension to show up in {profile.name}…</p>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant={done ? 'primary' : 'ghost'} onClick={onClose}>
          {done ? 'Close' : 'Finish later'}
        </Button>
      </div>
    </Dialog>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-ink-2 tabular-nums">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{title}</div>
        {children}
      </div>
    </li>
  );
}
