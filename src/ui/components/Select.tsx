import { Select as RSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './ui';

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  id?: string;
  label?: string;
  className?: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger
        id={id}
        aria-label={label}
        className={cx(
          'no-drag inline-flex h-9 w-full items-center justify-between gap-2 rounded-sm border border-line bg-sunken px-3 text-sm text-ink outline-none',
          'transition-[border-color] duration-150 focus-visible:border-fiber data-[placeholder]:text-ink-3',
          className,
        )}
      >
        <RSelect.Value />
        <RSelect.Icon>
          <ChevronDown className="size-4 text-ink-3" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="animate-fade z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-sm border border-line-strong bg-surface"
        >
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex h-8 cursor-default items-center rounded-[4px] pr-8 pl-2.5 text-sm text-ink outline-none select-none data-[highlighted]:bg-hover"
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-4 text-fiber-text" />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
