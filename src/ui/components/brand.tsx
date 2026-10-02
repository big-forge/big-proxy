import { Cloud, Globe, Laptop, Waypoints } from 'lucide-react';
import type { AppState, Exit } from '../../shared/types';
import { providerLabel, upstreamHost } from '../lib/format';
import { cx } from './ui';

/** One source, three exits, one of them live: the app in a glyph. Same drawing as the app icon. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={cx('size-5', className)}>
      <g opacity="0.45">
        <path d="M7.4 12H10.5M10.5 12L16.6 6M10.5 12L16.6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="19" cy="6" r="2" fill="currentColor" />
        <circle cx="19" cy="18" r="2" fill="currentColor" />
      </g>
      <circle cx="5" cy="12" r="2.4" fill="currentColor" />
      <path d="M10.5 12H16.6" stroke="var(--fiber)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="19" cy="12" r="2.2" fill="var(--fiber)" />
    </svg>
  );
}

/**
 * The path traffic takes right now: this computer → local gateway → provider → exit IP.
 * Lines carry moving dashes while connected.
 */
export function RouteLine({ state, exit }: { state: AppState; exit: Exit | undefined }) {
  const live = state.status === 'on';
  const nodes = [
    { Icon: Laptop, label: 'This computer', value: state.systemProxyActive ? 'System proxy on' : 'Apps you point here' },
    { Icon: Waypoints, label: 'Gateway', value: `127.0.0.1:${state.settings.gatewayPort}` },
    { Icon: Cloud, label: providerLabel(exit, state.accounts), value: exit ? upstreamHost(exit, state.accounts) : 'None' },
    { Icon: Globe, label: 'Exit IP', value: exit?.lastCheck?.info?.ip ?? 'Unknown' },
  ];
  return (
    <ol aria-label={live ? 'Traffic route, live' : 'Traffic route, not connected'} className="flex flex-col sm:flex-row sm:items-center">
      {nodes.map(({ Icon, label, value }, i) => (
        <li key={label} className="contents">
          {i > 0 && (
            <span
              aria-hidden
              className={cx(
                'ml-[15px] h-4 w-px sm:mx-3 sm:h-px sm:min-w-6 sm:flex-1',
                live ? 'bg-fiber sm:route-live' : 'bg-line-strong',
              )}
            />
          )}
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cx(
                'flex size-8 shrink-0 items-center justify-center rounded-full border transition-[color,border-color,background-color] duration-200',
                live ? 'border-transparent bg-fiber-soft text-fiber-text' : 'border-line bg-surface text-ink-3',
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[12px] text-ink-3">{label}</span>
              <span className="block truncate font-mono text-[12px] text-ink-2">{value}</span>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Sparkline({ values, slots = 60, className }: { values: number[]; slots?: number; className?: string }) {
  const w = 300;
  const h = 48;
  const max = Math.max(1024, ...values);
  const offset = slots - values.length;
  const pts = values.map((v, i) => [((offset + i) / (slots - 1)) * w, h - 2 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${w} ${h} L${pts[0][0].toFixed(1)} ${h} Z` : '';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className={cx('h-12 w-full', className)}>
      <line x1="0" x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--line)" />
      {pts.length > 1 && (
        <>
          <path d={area} fill="var(--fiber-soft)" />
          <path d={line} fill="none" stroke="var(--fiber)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}
