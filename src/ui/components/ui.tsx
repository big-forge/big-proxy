import { Switch as RSwitch, Tooltip as RTooltip } from 'radix-ui';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-fiber text-fiber-ink hover:bg-fiber-hover',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-hover',
  ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
  danger: 'bg-danger text-white hover:opacity-90',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-[15px]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'no-drag inline-flex shrink-0 items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap select-none',
        'transition-[background-color,color,opacity,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export function Tooltip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="animate-fade z-50 max-w-72 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-2"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltip?: boolean }>(function IconButton(
  { label, tooltip = true, className, type = 'button', ...props },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(
        'no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-3',
        'transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.95] disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
  return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button;
});

const fieldBase =
  'w-full rounded-sm border border-line bg-sunken px-3 text-sm text-ink placeholder:text-ink-3 transition-[border-color] duration-150 outline-none focus-visible:border-fiber focus-visible:outline-none aria-invalid:border-danger disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx(fieldBase, 'h-9', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, 'min-h-20 resize-y py-2 leading-relaxed', className)} {...props} />;
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children(id, hintId)}
      {error ? (
        <p id={hintId} className="text-[12px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[12px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={cx(
        'no-drag relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color] duration-150 disabled:opacity-50',
        'bg-line-strong data-[state=checked]:bg-fiber',
        // Larger hit area than the visual track.
        'before:absolute before:-inset-2.5 before:content-[""]',
      )}
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  );
}

/** Setting row: label + description on the left, control on the right. */
export function Row({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{title}</div>
        {description && <div className="mt-0.5 text-[13px] text-ink-3">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

export function Panel({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' }) {
  return <As className={cx('rounded-md border border-line bg-surface', className)}>{children}</As>;
}

export function PanelHeader({ title, children, id }: { title: ReactNode; children?: ReactNode; id?: string }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4">
      <h2 id={id} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      {children && <div className="flex items-center gap-1">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-line-strong px-1 font-sans text-[11px] text-ink-3">{children}</kbd>;
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block animate-pulse rounded-[4px] bg-hover', className)} />;
}

const NOTICE = {
  error: { cls: 'bg-danger-soft text-danger', Icon: CircleAlert },
  warn: { cls: 'bg-amber-soft text-amber', Icon: TriangleAlert },
  info: { cls: 'bg-hover text-ink-2', Icon: Info },
};

export function Notice({ tone, children, action }: { tone: keyof typeof NOTICE; children: ReactNode; action?: ReactNode }) {
  const { cls, Icon } = NOTICE[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('flex items-start gap-2.5 rounded-sm px-3 py-2.5 text-[13px]', cls)}>
      <Icon className="mt-px size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-pretty">{children}</div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-sm border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-[4px] px-3 text-[13px] font-medium transition-[background-color,color] duration-150',
            value === o.value ? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line)]' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-[60ch] text-[13px] text-ink-3">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
