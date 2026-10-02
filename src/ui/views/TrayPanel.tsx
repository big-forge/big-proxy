import { Check, Copy, Globe, Power, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppState, Exit } from '../../shared/types';
import { Logo } from '../components/brand';
import { Flag } from '../components/Flag';
import { Button, cx } from '../components/ui';
import { api, token } from '../lib/api';
import { countryName, exitCountry, modeLabel, placeLine } from '../lib/format';

const shell = (action: 'show' | 'quit' | 'hide') =>
  fetch(`/api/shell/${action}`, { method: 'POST', headers: { 'x-proxy-app-token': token } }).catch(() => {});

/** The window that drops down from the menu bar / tray icon. Same tokens as the main app. */
export function TrayPanel({ state }: { state: AppState }) {
  const exit = state.exits.find((e) => e.id === state.activeExitId);
  const on = state.status === 'on';
  const connecting = state.status === 'connecting';
  const check = exit?.lastCheck;
  const checking = exit ? state.checking.includes(exit.id) : false;
  const [busy, setBusy] = useState<'power' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canRotate = on && exit?.kind === 'provider' && exit.mode === 'sticky';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && void shell('hide');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = async (kind: 'power' | 'rotate', fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const place = [placeLine(check?.info), check?.info?.countryCode ? countryName(check.info.countryCode) : ''].filter(Boolean).join(', ');
  const ip = check?.ok ? check.info?.ip : undefined;

  return (
    <div id="tray-root" className="flex w-[320px] flex-col bg-canvas text-ink">
      <header className="flex h-12 items-center justify-between px-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Logo />
          Proxy App
        </div>
        <span
          role="status"
          className={cx(
            'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium',
            on ? 'bg-fiber-soft text-fiber-text' : state.status === 'error' ? 'bg-danger-soft text-danger' : 'border border-line text-ink-2',
          )}
        >
          <span className={cx('size-1.5 rounded-full', on ? 'bg-fiber' : state.status === 'error' ? 'bg-danger' : 'bg-ink-3')} aria-hidden />
          {on ? 'Connected' : connecting ? 'Connecting' : state.status === 'error' ? 'Problem' : 'Off'}
        </span>
      </header>

      <section className="border-t border-line px-4 pt-4 pb-4" aria-live="polite">
        {exit ? (
          <>
            <div className="flex min-h-8 items-center gap-2.5">
              <Flag code={exitCountry(exit)} className="h-[18px] w-[27px]" />
              <span className={cx('min-w-0 flex-1 truncate font-mono text-2xl leading-tight font-semibold tracking-[-0.02em] tabular-nums', !ip && 'text-lg text-ink-3')}>
                {ip ?? (checking ? 'Looking up…' : check && !check.ok ? 'No answer' : 'Not checked')}
              </span>
              {ip && (
                <button
                  type="button"
                  aria-label={copied ? 'Copied' : 'Copy IP address'}
                  onClick={() =>
                    navigator.clipboard.writeText(ip).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    })
                  }
                  className="flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-[background-color,color] duration-150 hover:bg-hover hover:text-ink"
                >
                  {copied ? <Check className="size-4 text-fiber-text" /> : <Copy className="size-4" />}
                </button>
              )}
            </div>
            {place && <p className="mt-1.5 text-[15px] font-semibold text-ink">{place}</p>}
            <p className="mt-0.5 truncate text-[13px] text-ink-2">
              {exit.name} · {modeLabel(exit)}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-ink-2">No IP selected. Open Proxy App to add one.</p>
        )}

        {(state.statusError || state.upstreamError || error) && (
          <p role="alert" className="mt-3 rounded-sm bg-danger-soft px-2.5 py-2 text-[13px] text-danger">
            {error ?? state.statusError ?? state.upstreamError?.message}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          {canRotate && (
            <Button
              variant="primary"
              className="h-9 min-w-0 flex-1 px-3"
              disabled={busy !== null || checking}
              onClick={() => run('rotate', async () => void (await api.rotate(exit!.id)))}
            >
              <RefreshCw className={cx((busy === 'rotate' || checking) && 'animate-spin')} aria-hidden />
              New IP
            </Button>
          )}
          <Button
            variant={on ? 'secondary' : 'primary'}
            className="h-9 min-w-0 flex-1 px-3"
            disabled={busy !== null || connecting || !exit}
            onClick={() => run('power', () => (on ? api.disconnect() : api.connect()))}
          >
            <Power aria-hidden />
            {on ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      </section>

      {state.exits.length > 0 && (
        <section className="border-t border-line px-2 pt-3 pb-2" aria-labelledby="tray-ips">
          <h2 id="tray-ips" className="px-2 pb-1.5 text-[12px] font-medium text-ink-3">
            Switch IP
          </h2>
          <div role="radiogroup" aria-labelledby="tray-ips" className="flex max-h-[220px] flex-col gap-px overflow-y-auto">
            {state.exits.map((e) => (
              <ExitOption key={e.id} exit={e} active={e.id === state.activeExitId} checking={state.checking.includes(e.id)} />
            ))}
          </div>
        </section>
      )}

      <footer className="flex items-center justify-between border-t border-line px-2 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => void shell('show')}>
          Open Proxy App
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void shell('quit')}>
          Quit
        </Button>
      </footer>
    </div>
  );
}

function ExitOption({ exit, active, checking }: { exit: Exit; active: boolean; checking: boolean }) {
  const code = exitCountry(exit);
  const info = exit.lastCheck?.ok ? exit.lastCheck : undefined;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => !active && void api.activate(exit.id)}
      className={cx(
        'flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-[background-color] duration-150',
        active ? 'bg-fiber-soft' : 'hover:bg-hover',
      )}
    >
      {code ? <Flag code={code} /> : <Globe className="h-[18px] w-[27px] text-ink-3" aria-hidden />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{exit.name}</span>
        <span className={cx('block truncate font-mono text-[12px] text-ink-3 tabular-nums', checking && 'opacity-50')}>
          {info?.info?.ip ?? (exit.lastCheck && !exit.lastCheck.ok ? 'No answer' : 'Not checked')}
        </span>
      </span>
      {info?.latencyMs ? <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">{info.latencyMs} ms</span> : null}
      <span className="w-4 shrink-0">{active && <Check className="size-4 text-fiber-text" aria-hidden />}</span>
    </button>
  );
}
