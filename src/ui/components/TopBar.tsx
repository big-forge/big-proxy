import { Activity, AppWindow, Power, Settings, Smartphone } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { Logo } from './brand';
import { cx } from './ui';

export type View = 'connect' | 'apps' | 'devices' | 'activity' | 'settings';

const TABS: { view: View; label: string; Icon: typeof Power }[] = [
  { view: 'connect', label: 'Connect', Icon: Power },
  { view: 'apps', label: 'Apps', Icon: AppWindow },
  { view: 'devices', label: 'Devices', Icon: Smartphone },
  { view: 'activity', label: 'Activity', Icon: Activity },
  { view: 'settings', label: 'Settings', Icon: Settings },
];

const STATUS = {
  on: { text: 'Connected', dot: 'bg-fiber' },
  connecting: { text: 'Connecting', dot: 'bg-amber animate-pulse' },
  error: { text: 'Not connected', dot: 'bg-danger' },
  off: { text: 'Off', dot: 'bg-ink-3' },
};

export function TopBar({ state, view }: { state: AppState; view: View }) {
  const desktop = state.shell === 'desktop';
  const mac = state.platform === 'darwin';
  const status = STATUS[state.status];
  return (
    <header
      className={cx(
        'drag flex h-12 shrink-0 items-center gap-3 border-b border-line bg-canvas',
        // Room for the macOS traffic lights / the Windows caption buttons.
        desktop && mac ? 'pl-[84px]' : 'pl-4',
        desktop && !mac ? 'pr-[148px]' : 'pr-4',
      )}
    >
      <a href="#connect" className="no-drag flex items-center gap-2 rounded-sm text-ink">
        <Logo />
        <span className="hidden text-sm font-semibold md:inline">Proxy App</span>
      </a>
      <nav aria-label="Main" className="no-drag ml-2 flex items-stretch self-stretch">
        {TABS.map(({ view: v, label, Icon }) => (
          <a
            key={v}
            href={`#${v}`}
            aria-current={view === v ? 'page' : undefined}
            className={cx(
              'relative flex items-center gap-1.5 px-2.5 text-[13px] font-medium transition-[color] duration-150',
              'after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full',
              view === v ? 'text-ink after:bg-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            <Icon className="size-4 sm:hidden" aria-hidden />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </a>
        ))}
      </nav>
      <div className="ml-auto flex h-7 items-center gap-2 rounded-full border border-line px-2.5 text-[12px] font-medium text-ink-2" role="status">
        <span className={cx('size-2 rounded-full', status.dot)} aria-hidden />
        {status.text}
      </div>
    </header>
  );
}
