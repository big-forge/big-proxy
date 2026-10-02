import { Tooltip } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Toaster } from './components/Toaster';
import { TopBar, type View } from './components/TopBar';
import { Button, Notice, Skeleton } from './components/ui';
import { api } from './lib/api';
import type { AppState } from '../shared/types';
import { useLive } from './lib/live';
import { ActivityView } from './views/ActivityView';
import { AppsView } from './views/AppsView';
import { ConnectView } from './views/ConnectView';
import { DevicesView } from './views/DevicesView';
import { Onboarding } from './views/Onboarding';
import { SettingsView } from './views/SettingsView';
import { TrayPanel } from './views/TrayPanel';

const VIEWS: View[] = ['connect', 'apps', 'devices', 'activity', 'settings', 'tray' as View];

function readView(): View {
  const v = location.hash.slice(1) as View;
  return VIEWS.includes(v) ? v : 'connect';
}

function useView(): View {
  const [view, setView] = useState(readView);
  useEffect(() => {
    const on = () => setView(readView());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return view;
}

export function App() {
  const state = useLive((l) => l.state);
  const online = useLive((l) => l.online);
  const view = useView();
  const theme = state?.settings.theme;

  useEffect(() => {
    if (!theme || theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.getElementById('main')?.scrollTo({ top: 0 });
  }, [view]);

  // The menu bar / tray popover is this same app, loaded at #tray in its own small window.
  if (state && view === ('tray' as View)) return <TrayPanel state={state} />;

  if (!state) {
    return (
      <div className="flex h-dvh flex-col">
        <div className="drag h-12 border-b border-line" />
        <div className="mx-auto w-full max-w-[1240px] px-6 py-6" aria-busy="true">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="mt-5 h-72 w-full" />
        </div>
      </div>
    );
  }

  const fresh = state.exits.length === 0 && state.accounts.length === 0;

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="flex h-dvh flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <TopBar state={state} view={fresh ? 'connect' : view} />
        {!online && (
          <div className="border-b border-line px-4 py-2">
            <Notice tone="warn">Lost contact with the Proxy App service. Reconnecting…</Notice>
          </div>
        )}
        <UpdateBanner state={state} />
        <main id="main" className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          {fresh ? (
            <Onboarding state={state} />
          ) : view === 'apps' ? (
            <AppsView state={state} />
          ) : view === 'devices' ? (
            <DevicesView state={state} />
          ) : view === 'activity' ? (
            <ActivityView state={state} />
          ) : view === 'settings' ? (
            <SettingsView state={state} />
          ) : (
            <ConnectView state={state} />
          )}
        </main>
      </div>
      <Toaster />
    </Tooltip.Provider>
  );
}

/** Quiet strip at the top, only when an update is waiting. */
function UpdateBanner({ state }: { state: AppState }) {
  const u = state.update;
  if (!u || (u.status !== 'ready' && u.status !== 'available')) return null;
  const ready = u.status === 'ready';
  return (
    <div className="border-b border-line px-4 py-2">
      <Notice
        tone="info"
        action={
          <Button size="sm" variant="primary" onClick={() => api.shell(ready ? 'updateInstall' : 'updatePage').catch(() => {})}>
            {ready ? 'Restart to update' : `Download ${u.version}`}
          </Button>
        }
      >
        {ready ? `Proxy App ${u.version} is ready to install.` : `Proxy App ${u.version} is available.`}
      </Notice>
    </div>
  );
}
