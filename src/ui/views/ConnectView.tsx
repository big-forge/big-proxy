import { ArrowDown, ArrowUp, Check, Copy, Ellipsis, Plus, Power, RefreshCw } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, Exit } from '../../shared/types';
import { RouteLine, Sparkline } from '../components/brand';
import { ConfirmDialog } from '../components/Dialog';
import { Flag } from '../components/Flag';
import { toast, toastError } from '../components/Toaster';
import { Button, IconButton, Kbd, Notice, Panel, PanelHeader, Skeleton, Switch, Tooltip, cx } from '../components/ui';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { ago, bytes, countryName, exitCountry, modeLabel, placeLine, rate } from '../lib/format';
import { AddIpsDialog, EditExitDialog } from './forms';

export function ConnectView({ state }: { state: AppState }) {
  const exits = state.exits;

  // 1–9 switch IPs, like channels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && exits[n - 1]) {
        e.preventDefault();
        api.activate(exits[n - 1].id).catch(toastError);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exits]);

  return (
    <div className="mx-auto grid max-w-[1240px] gap-5 px-4 py-5 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-5">
        <NowPanel state={state} />
        <ExitList state={state} />
      </div>
      <aside className="flex flex-col gap-5" aria-label="Connection details">
        <GatewayCard state={state} />
        <TrafficCard state={state} />
        <DevicesCard state={state} />
      </aside>
    </div>
  );
}

function NowPanel({ state }: { state: AppState }) {
  const exit = state.exits.find((e) => e.id === state.activeExitId);
  const check = exit?.lastCheck;
  const checking = exit ? state.checking.includes(exit.id) : false;
  const on = state.status === 'on';
  const connecting = state.status === 'connecting';
  const [busy, setBusy] = useState(false);
  const canRotate = exit?.kind === 'provider' && exit.mode === 'sticky';
  const failed = check && !check.ok;

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) await api.disconnect();
      else await api.connect();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!exit) return;
    try {
      const res = await api.rotate(exit.id);
      if (res.ok) toast(`New IP: ${res.info?.ip}`);
      else toast(res.error ?? "Couldn't get a working IP", 'error');
    } catch (err) {
      toastError(err);
    }
  };

  const heading = on ? 'Connected. Traffic leaves from' : connecting ? 'Connecting…' : 'Not connected. Ready to use';

  return (
    <Panel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <p className={cx('text-[13px] font-medium', on ? 'text-fiber-text' : 'text-ink-3')}>{heading}</p>
          <div className="mt-1.5 min-h-11 font-mono text-[32px] leading-[1.15] font-semibold tracking-[-0.02em] text-ink tabular-nums sm:text-[38px]" aria-live="polite">
            {check?.info?.ip && !(checking && !check.ok) ? (
              <span className={cx('transition-opacity duration-200', checking && 'opacity-50')}>{check.info.ip}</span>
            ) : checking ? (
              <Skeleton className="h-9 w-64 align-middle" />
            ) : failed ? (
              <span className="text-ink-3">No answer</span>
            ) : (
              <span className="text-ink-3">Unknown</span>
            )}
          </div>
          <div className="mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
            {failed && !checking ? (
              <span className="text-danger">{check.error}</span>
            ) : check?.info ? (
              <>
                <Flag code={check.info.countryCode} />
                <span>
                  {[placeLine(check.info), check.info.countryCode ? countryName(check.info.countryCode) : check.info.country].filter(Boolean).join(', ')}
                </span>
                {exit?.kind === 'provider' && exit.mode === 'rotating' && <span className="text-ink-3">Changes on every connection</span>}
              </>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canRotate && (
            <Button size="lg" onClick={rotate} disabled={checking}>
              <RefreshCw className={cx(checking && 'animate-spin')} aria-hidden />
              New IP
            </Button>
          )}
          <Button size="lg" variant={on ? 'secondary' : 'primary'} onClick={toggle} disabled={busy || connecting || !exit} className="min-w-36">
            <Power aria-hidden />
            {on ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Fact label="Using" value={exit?.name ?? 'Nothing selected'} />
        <Fact label="Type" value={exit ? modeLabel(exit) : '—'} />
        <Fact label="Network" value={check?.info?.isp ?? '—'} />
        <Fact label="Latency" value={check?.latencyMs ? `${check.latencyMs} ms` : '—'} hint={check ? `Checked ${ago(check.at)}` : undefined} />
      </dl>

      {(state.statusError || state.upstreamError || state.systemProxyError) && (
        <div className="mt-5 flex flex-col gap-2">
          {state.statusError && <Notice tone="error">{state.statusError}</Notice>}
          {state.upstreamError && (
            <Notice tone="warn" action={<a href="#settings" className="shrink-0 font-medium underline underline-offset-2">Check login</a>}>
              {state.upstreamError.message}
            </Notice>
          )}
          {state.systemProxyError && on && (
            <Notice tone="warn">
              {state.systemProxyError} Apps can still use <span className="font-mono">127.0.0.1:{state.settings.gatewayPort}</span>.
            </Notice>
          )}
        </div>
      )}

      <div className="mt-6 border-t border-line pt-5">
        <RouteLine state={state} exit={exit} />
      </div>
    </Panel>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-ink" title={hint ? `${value}. ${hint}` : value}>
        {value}
      </dd>
    </div>
  );
}

function ExitList({ state }: { state: AppState }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Exit | null>(null);
  const [removing, setRemoving] = useState<Exit | null>(null);
  const exits = state.exits;

  return (
    <Panel>
      <PanelHeader
        id="ips-heading"
        title={
          <>
            Your IPs <span className="ml-1 font-normal text-ink-3 tabular-nums">{exits.length}</span>
          </>
        }
      >
        {exits.length > 1 && (
          <Button variant="ghost" size="sm" onClick={() => api.checkAll().catch(toastError)}>
            Check all
          </Button>
        )}
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add IPs
        </Button>
      </PanelHeader>

      {exits.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">No IPs yet</p>
          <p className="max-w-[44ch] text-[13px] text-ink-3">Add IPs from your saved login, or paste proxies from any provider.</p>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add IPs
          </Button>
        </div>
      ) : (
        <ul aria-labelledby="ips-heading" className="divide-y divide-line">
          {exits.map((exit, i) => (
            <ExitRow key={exit.id} exit={exit} index={i} state={state} onEdit={() => setEditing(exit)} onRemove={() => setRemoving(exit)} />
          ))}
        </ul>
      )}

      {exits.length > 1 && (
        <p className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-[12px] text-ink-3">
          Press <Kbd>1</Kbd>–<Kbd>{Math.min(9, exits.length)}</Kbd> to switch. Open connections move to the new IP at once.
        </p>
      )}

      {adding && <AddIpsDialog state={state} open={adding} onOpenChange={setAdding} />}
      {editing && <EditExitDialog exit={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove ${removing?.name}?`}
        description="It disappears from your list. You can add it again any time."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (removing) await api.deleteExit(removing.id).catch(toastError);
        }}
      />
    </Panel>
  );
}

function ExitRow({ exit, index, state, onEdit, onRemove }: { exit: Exit; index: number; state: AppState; onEdit: () => void; onRemove: () => void }) {
  const active = exit.id === state.activeExitId;
  const checking = state.checking.includes(exit.id);
  const check = exit.lastCheck;
  const canRotate = exit.kind === 'provider' && exit.mode === 'sticky';
  const [copied, setCopied] = useState(false);

  const activate = () => {
    if (!active) api.activate(exit.id).catch(toastError);
  };

  return (
    <li className={cx('group relative flex min-h-16 items-center gap-3 px-4 py-2.5 transition-[background-color] duration-150', active ? 'bg-fiber-soft' : 'hover:bg-hover')}>
      {/* The whole row switches to this IP; the action buttons sit above it. */}
      <button
        type="button"
        onClick={activate}
        aria-pressed={active}
        aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-fiber focus-visible:ring-inset"
      >
        <span className="sr-only">
          {active ? `${exit.name}, in use` : `Switch to ${exit.name}`}
        </span>
      </button>

      <span
        aria-hidden
        className={cx('pointer-events-none flex size-4 shrink-0 items-center justify-center rounded-full border-2', active ? 'border-fiber' : 'border-line-strong')}
      >
        {active && <span className="size-1.5 rounded-full bg-fiber" />}
      </span>
      <Flag code={exitCountry(exit)} className="pointer-events-none" />

      <div className="pointer-events-none min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{exit.name}</div>
        <div className="truncate text-[12px] text-ink-3">{modeLabel(exit)}</div>
      </div>

      <div className="pointer-events-none hidden w-[190px] min-w-0 text-right sm:block">
        {check?.ok && check.info ? (
          <>
            <div className={cx('truncate font-mono text-[13px] text-ink-2 tabular-nums', checking && 'opacity-50')}>{check.info.ip}</div>
            <div className="truncate text-[12px] text-ink-3">{checking ? 'Checking' : placeLine(check.info)}</div>
          </>
        ) : checking ? (
          <Skeleton className="h-4 w-28" />
        ) : check ? (
          <Tooltip label={check.error}>
            <span className="pointer-events-auto relative z-10 text-[13px] text-danger">No answer</span>
          </Tooltip>
        ) : (
          <span className="text-[13px] text-ink-3">Not checked</span>
        )}
      </div>

      <div className="pointer-events-none hidden w-16 text-right text-[12px] text-ink-3 tabular-nums md:block">{check?.ok && check.latencyMs ? `${check.latencyMs} ms` : ''}</div>

      <div className="relative z-10 flex items-center">
        {canRotate && (
          <IconButton
            label={`New IP for ${exit.name}`}
            disabled={checking}
            onClick={async () => {
              try {
                const res = await api.rotate(exit.id);
                if (!res.ok) toast(res.error ?? "Couldn't get a working IP", 'error');
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <RefreshCw className={cx(checking && 'animate-spin')} />
          </IconButton>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label={`More for ${exit.name}`} tooltip={false}>
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="animate-fade z-50 min-w-48 rounded-sm border border-line-strong bg-surface p-1">
              <MenuItem onSelect={() => api.check(exit.id).catch(toastError)}>Check IP</MenuItem>
              <MenuItem onSelect={onEdit}>Edit…</MenuItem>
              {exit.port && (
                <MenuItem
                  onSelect={() =>
                    void navigator.clipboard.writeText(`127.0.0.1:${exit.port}`).then(() => toast(`Copied 127.0.0.1:${exit.port}. It always uses ${exit.name}.`))
                  }
                >
                  Copy fixed address
                </MenuItem>
              )}
              <MenuItem
                onSelect={() => {
                  api
                    .exitUrl(exit.id)
                    .then(({ url }) => navigator.clipboard.writeText(url))
                    .then(() => {
                      setCopied(true);
                      toast('Proxy URL copied. It includes the login, so share it carefully.');
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(toastError);
                }}
              >
                {copied ? 'Copied' : 'Copy as proxy URL'}
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <MenuItem onSelect={onRemove} danger>
                Remove
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </li>
  );
}

function MenuItem({ children, onSelect, danger }: { children: ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cx('flex h-8 cursor-default items-center rounded-[4px] px-2.5 text-sm outline-none select-none data-[highlighted]:bg-hover', danger ? 'text-danger' : 'text-ink')}
    >
      {children}
    </DropdownMenu.Item>
  );
}

function GatewayCard({ state }: { state: AppState }) {
  const address = `127.0.0.1:${state.settings.gatewayPort}`;
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Panel className="p-4">
      <h2 className="text-sm font-semibold text-ink">Use in apps</h2>
      <div className="mt-3 flex h-10 items-center justify-between rounded-sm border border-line bg-sunken pr-1 pl-3">
        <span className="font-mono text-[14px] text-ink">{address}</span>
        <IconButton label={copied ? 'Copied' : 'Copy address'} onClick={copy}>
          {copied ? <Check className="text-fiber-text" /> : <Copy />}
        </IconButton>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">HTTP and SOCKS5 on the same port.</p>
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-line pt-4">
        <div>
          <div className="text-sm font-medium text-ink">Route this whole computer</div>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {state.settings.systemProxy
              ? 'Every app, update and sync uses proxy data. Turn off to proxy only chosen browser profiles.'
              : 'Off: only the browser profiles and apps you choose use the proxy.'}
          </p>
        </div>
        <Switch label="Route this whole computer" checked={state.settings.systemProxy} onChange={(systemProxy) => api.updateSettings({ systemProxy }).catch(toastError)} />
      </div>
      <a
        href="#apps"
        className="mt-4 inline-flex h-8 items-center rounded-sm border border-line-strong px-3 text-[13px] font-medium text-ink transition-[background-color] duration-150 hover:bg-hover"
      >
        Choose apps and profiles
      </a>
    </Panel>
  );
}

function TrafficCard({ state }: { state: AppState }) {
  const stats = useLive((l) => l.stats);
  const last = stats.at(-1);
  const on = state.status === 'on';
  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink">Traffic</h2>
        <span className="text-[12px] text-ink-3 tabular-nums">{last?.active ?? 0} open</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1 text-[12px] text-ink-3">
            <ArrowDown className="size-3.5" aria-hidden /> Down
          </div>
          <div className="text-lg font-semibold text-ink tabular-nums">{on ? rate(last?.downRate ?? 0) : '—'}</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-[12px] text-ink-3">
            <ArrowUp className="size-3.5" aria-hidden /> Up
          </div>
          <div className="text-lg font-semibold text-ink tabular-nums">{on ? rate(last?.upRate ?? 0) : '—'}</div>
        </div>
      </div>
      <Sparkline values={stats.map((s) => s.downRate + s.upRate)} className="mt-3" />
      <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[12px]">
        <div>
          <dt className="text-ink-3">This session</dt>
          <dd className="mt-0.5 font-medium text-ink tabular-nums">{bytes((last?.up ?? 0) + (last?.down ?? 0))}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Since {new Date(state.usage.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</dt>
          <dd className="mt-0.5 font-medium text-ink tabular-nums">{bytes(state.usage.up + state.usage.down)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function DevicesCard({ state }: { state: AppState }) {
  const lan = state.settings.allowLan;
  const ip = state.lanAddresses[0];
  return (
    <Panel className="p-4">
      <h2 className="text-sm font-semibold text-ink">Phones and other devices</h2>
      <p className="mt-1 text-[12px] text-ink-3">
        {lan && ip ? (
          <>
            On. Set <span className="font-mono text-ink-2">{`${ip}:${state.settings.gatewayPort}`}</span> as the Wi-Fi proxy on your phone.
          </>
        ) : (
          'Let phones on your Wi-Fi use this connection and switch with it.'
        )}
      </p>
      <a
        href="#devices"
        className="mt-3 inline-flex h-8 items-center rounded-sm border border-line-strong px-3 text-[13px] font-medium text-ink transition-[background-color] duration-150 hover:bg-hover"
      >
        {lan ? 'Setup guide' : 'Set up'}
      </a>
    </Panel>
  );
}
