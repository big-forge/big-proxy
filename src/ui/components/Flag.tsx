import * as Flags from 'country-flag-icons/react/3x2';
import { Globe } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { cx } from './ui';

const FLAGS = Flags as unknown as Record<string, ComponentType<SVGProps<SVGSVGElement> & { title?: string }>>;

/** SVG flags, since Windows doesn't draw flag emoji. */
export function Flag({ code, className }: { code?: string; className?: string }) {
  const Svg = code ? FLAGS[code.toUpperCase()] : undefined;
  if (!Svg) return <Globe aria-hidden className={cx('size-4 shrink-0 text-ink-3', className)} />;
  return <Svg aria-hidden className={cx('h-3.5 w-[21px] shrink-0 rounded-[2px] shadow-[0_0_0_1px_var(--line)]', className)} />;
}
