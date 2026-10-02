import { CircleAlert, CircleCheck } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cx } from './ui';

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = { id: nextId++, text, tone };
  toasts = [...toasts.slice(-2), t];
  emit();
  setTimeout(
    () => {
      toasts = toasts.filter((x) => x.id !== t.id);
      emit();
    },
    tone === 'error' ? 6000 : 3500,
  );
}

export function toastError(err: unknown) {
  toast(err instanceof Error ? err.message : String(err), 'error');
}

export function Toaster() {
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className="animate-enter pointer-events-auto flex items-start gap-2.5 rounded-md border border-line-strong bg-surface px-3.5 py-3 text-[13px] text-ink"
        >
          {t.tone === 'ok' ? (
            <CircleCheck className="mt-px size-4 shrink-0 text-fiber-text" aria-hidden />
          ) : (
            <CircleAlert className={cx('mt-px size-4 shrink-0 text-danger')} aria-hidden />
          )}
          <span className="text-pretty">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
