import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppState } from '../../shared/types';
import { toastError } from '../components/Toaster';
import { Button, Input, PageHeader, Panel, cx } from '../components/ui';
import { api } from '../lib/api';
import { bytes, clock, duration } from '../lib/format';
import { clearLocalActivity, useLive } from '../lib/live';

export function ActivityView({ state }: { state: AppState }) {
  const activity = useLive((l) => l.activity);
  const [query, setQuery] = useState('');
  const names = useMemo(() => new Map(state.exits.map((e) => [e.id, e.name])), [state.exits]);
  const q = query.trim().toLowerCase();
  const rows = q ? activity.filter((a) => a.host.toLowerCase().includes(q) || (a.exitId && names.get(a.exitId)?.toLowerCase().includes(q))) : activity;

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6">
      <PageHeader title="Activity" description="Recent connections through the gateway. Kept in memory only, and cleared when the app quits.">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input aria-label="Filter by site or IP name" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56 pl-9" />
        </div>
        <Button
          variant="ghost"
          disabled={!activity.length}
          onClick={() =>
            api
              .clearActivity()
              .then(clearLocalActivity)
              .catch(toastError)
          }
        >
          Clear
        </Button>
      </PageHeader>

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-ink">{q ? 'Nothing matches that filter' : 'No connections yet'}</p>
            <p className="mx-auto mt-1 max-w-[52ch] text-[13px] text-ink-3">
              {q ? 'Try part of a site name.' : `Connect, then browse, or point an app at 127.0.0.1:${state.settings.gatewayPort}.`}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="h-10 px-4 font-medium">Time</th>
                  <th scope="col" className="h-10 px-4 font-medium">Destination</th>
                  <th scope="col" className="hidden h-10 px-4 font-medium md:table-cell">Through</th>
                  <th scope="col" className="hidden h-10 px-4 font-medium sm:table-cell">From</th>
                  <th scope="col" className="h-10 px-4 text-right font-medium">Data</th>
                  <th scope="col" className="hidden h-10 px-4 text-right font-medium lg:table-cell">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.slice(0, 300).map((a) => (
                  <tr key={a.id} className="hover:bg-hover">
                    <td className="h-10 px-4 whitespace-nowrap text-ink-3 tabular-nums">{clock(a.at)}</td>
                    <td className="max-w-[340px] truncate px-4 font-mono text-[12px] text-ink" title={`${a.host}:${a.port}`}>
                      {a.host}
                      {a.port !== 443 && a.port !== 80 && <span className="text-ink-3">:{a.port}</span>}
                    </td>
                    <td className="hidden px-4 whitespace-nowrap text-ink-2 md:table-cell">{a.direct ? 'Direct (local)' : (a.exitId && names.get(a.exitId)) || 'Removed IP'}</td>
                    <td className="hidden px-4 font-mono text-[12px] whitespace-nowrap text-ink-3 sm:table-cell">{a.client === '127.0.0.1' || a.client === '::1' ? 'This computer' : a.client}</td>
                    <td className="px-4 text-right whitespace-nowrap text-ink-2 tabular-nums">{a.status === 'failed' ? '—' : bytes(a.up + a.down)}</td>
                    <td className="hidden max-w-[260px] px-4 text-right lg:table-cell">
                      <span
                        className={cx('block truncate', a.status === 'failed' ? 'text-danger' : a.status === 'open' ? 'text-fiber-text' : 'text-ink-3')}
                        title={a.error}
                      >
                        {a.status === 'failed' ? a.error : a.status === 'open' ? 'Open' : duration(a.durationMs ?? 0)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {rows.length > 300 && <p className="mt-3 text-[12px] text-ink-3">Showing the latest 300 of {rows.length}.</p>}
    </div>
  );
}
