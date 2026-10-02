import { AlertDialog as RAlert, Dialog as RDialog } from 'radix-ui';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, IconButton } from './ui';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 520,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-overlay" />
        <RDialog.Content
          style={{ maxWidth: width }}
          className="animate-enter fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line-strong bg-surface"
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <RDialog.Title className="text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-[13px] text-ink-3">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close asChild>
              <IconButton label="Close" tooltip={false} className="-mt-1 -mr-2">
                <X />
              </IconButton>
            </RDialog.Close>
          </div>
          <div className="overflow-y-auto px-5 pt-4 pb-5">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

/** For removals: the destructive button lives inside the dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <RAlert.Root open={open} onOpenChange={onOpenChange}>
      <RAlert.Portal>
        <RAlert.Overlay className="animate-fade fixed inset-0 z-40 bg-overlay" />
        <RAlert.Content className="animate-enter fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-strong bg-surface p-5">
          <RAlert.Title className="text-base font-semibold text-ink">{title}</RAlert.Title>
          <RAlert.Description className="mt-1.5 text-[13px] text-ink-3">{description}</RAlert.Description>
          <div className="mt-6 flex justify-end gap-2">
            <RAlert.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </RAlert.Cancel>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </RAlert.Content>
      </RAlert.Portal>
    </RAlert.Root>
  );
}
