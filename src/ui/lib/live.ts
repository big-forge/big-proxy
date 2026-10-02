import { useSyncExternalStore } from 'react';
import type { ActivityEntry, AppState, TrafficStats } from '../../shared/types';
import { api, setStateSink, token } from './api';

export interface Live {
  state: AppState | null;
  /** Last 60 seconds, oldest first. */
  stats: TrafficStats[];
  activity: ActivityEntry[];
  online: boolean;
}

const HISTORY = 60;
const ACTIVITY_LIMIT = 500;

let live: Live = { state: null, stats: [], activity: [], online: true };
const listeners = new Set<() => void>();

function set(patch: Partial<Live>) {
  live = { ...live, ...patch };
  for (const l of listeners) l();
}

function mergeActivity(entries: ActivityEntry[]) {
  const byId = new Map(live.activity.map((e) => [e.id, e]));
  for (const e of entries) byId.set(e.id, e);
  set({ activity: [...byId.values()].sort((a, b) => b.id - a.id).slice(0, ACTIVITY_LIMIT) });
}

/** One event stream feeds the whole UI: state changes, a stats tick per second, and activity. */
export function startLive() {
  setStateSink((state) => set({ state }));
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('state', (e) => set({ state: JSON.parse((e as MessageEvent).data), online: true }));
  es.addEventListener('stats', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as TrafficStats;
    set({ stats: [...live.stats.slice(-(HISTORY - 1)), s] });
  });
  es.addEventListener('activity', (e) => mergeActivity(JSON.parse((e as MessageEvent).data)));
  es.onopen = () => {
    set({ online: true });
    api.activity().then(mergeActivity, () => {});
  };
  es.onerror = () => set({ online: false });
}

export function clearLocalActivity() {
  set({ activity: [] });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Select a field of the live store. Return stored references, not new objects. */
export function useLive<T>(select: (l: Live) => T): T {
  return useSyncExternalStore(subscribe, () => select(live));
}
