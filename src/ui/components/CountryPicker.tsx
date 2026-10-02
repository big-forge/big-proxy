import { Command } from 'cmdk';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { COUNTRIES, findCountry, SUGGESTED } from '../lib/countries';
import { Flag } from './Flag';
import { cx } from './ui';

const ANY = '__any';

/** Searchable country list. Value is a lowercase ISO code, '' for "any country". */
export function CountryPicker({ value, onChange, id }: { value: string; onChange: (code: string) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const selected = findCountry(value);
  const pick = (code: string) => {
    onChange(code === ANY ? '' : code.toLowerCase());
    setOpen(false);
  };

  const item = (code: string, name: string) => (
    <Command.Item
      key={code}
      value={`${name} ${code}`}
      onSelect={() => pick(code)}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-[4px] px-2 text-sm text-ink data-[selected=true]:bg-hover"
    >
      {code === ANY ? <Flag /> : <Flag code={code} />}
      <span className="flex-1 truncate">{name}</span>
      {(code === ANY ? !value : selected?.code === code) && <Check className="size-4 text-fiber-text" />}
    </Command.Item>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        id={id}
        className="no-drag inline-flex h-9 w-full items-center gap-2.5 rounded-sm border border-line bg-sunken px-3 text-left text-sm text-ink outline-none transition-[border-color] duration-150 focus-visible:border-fiber"
      >
        <Flag code={selected?.code} />
        <span className="flex-1 truncate">{selected?.name ?? 'Any country'}</span>
        <ChevronDown className="size-4 text-ink-3" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="animate-fade z-50 w-[var(--radix-popover-trigger-width)] min-w-64 rounded-sm border border-line-strong bg-surface"
        >
          <Command loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-ink-3" aria-hidden />
              <Command.Input autoFocus placeholder="Search countries" className="h-10 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3" />
            </div>
            <Command.List className="max-h-72 overflow-y-auto p-1">
              <Command.Empty className="px-2 py-6 text-center text-[13px] text-ink-3">No country by that name</Command.Empty>
              <Command.Group heading="Suggested" className={cx('[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-ink-3')}>
                {item(ANY, 'Any country')}
                {SUGGESTED.map((code) => item(code, findCountry(code)?.name ?? code))}
              </Command.Group>
              <Command.Group heading="All countries" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-ink-3">
                {COUNTRIES.filter((c) => !SUGGESTED.includes(c.code)).map((c) => item(c.code, c.name))}
              </Command.Group>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
