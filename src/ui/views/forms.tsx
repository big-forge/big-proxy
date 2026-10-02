import { CircleCheck, CircleAlert, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Account, AppState, Exit, ExitMode, ProxyProtocol, TestProxyResult } from '../../shared/types';
import { CountryPicker } from '../components/CountryPicker';
import { Dialog, DialogActions } from '../components/Dialog';
import { Select } from '../components/Select';
import { toast, toastError } from '../components/Toaster';
import { Button, Field, Input, Segmented, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { countryName, placeLine } from '../lib/format';

export interface ExitOptionsValue {
  country: string;
  city: string;
  mode: ExitMode;
  count: number;
  sessionMinutes: string;
}

const KEEP_FOR = [
  { value: 'default', label: '30 min (default)' },
  { value: '10', label: '10 min' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
];

export function defaultExitOptions(country = 'in'): ExitOptionsValue {
  return { country, city: '', mode: 'sticky', count: 3, sessionMinutes: 'default' };
}

export function sessionMinutesOf(v: ExitOptionsValue): number | undefined {
  return v.sessionMinutes === 'default' ? undefined : Number(v.sessionMinutes);
}

/** Where the IPs come from and how they behave. Shared by add and edit. */
export function ExitOptions({ value, onChange, showCount = true }: { value: ExitOptionsValue; onChange: (v: ExitOptionsValue) => void; showCount?: boolean }) {
  const set = (patch: Partial<ExitOptionsValue>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Country">{(id) => <CountryPicker id={id} value={value.country} onChange={(country) => set({ country })} />}</Field>
        <Field label="City" hint="Optional. Fewer IPs to pick from.">
          {(id, d) => <Input id={id} aria-describedby={d} value={value.city} onChange={(e) => set({ city: e.target.value })} placeholder="Any city" />}
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-ink">IP behaviour</span>
        <Segmented
          label="IP behaviour"
          value={value.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'sticky', label: 'Sticky IPs' },
            { value: 'rotating', label: 'Rotating' },
          ]}
        />
        <p className="text-[12px] text-ink-3">
          {value.mode === 'sticky'
            ? 'Each IP stays the same until you switch or ask for a new one. Best for logins and accounts.'
            : 'Every new connection leaves from a different IP. Best for scraping and quick checks.'}
        </p>
      </div>
      {(showCount || value.mode === 'sticky') && (
        <div className="grid gap-4 sm:grid-cols-2">
          {showCount && (
            <Field label="How many" hint={value.mode === 'sticky' ? 'Each one is a separate IP you can switch to.' : undefined}>
              {(id, d) => (
                <Input
                  id={id}
                  aria-describedby={d}
                  type="number"
                  min={1}
                  max={25}
                  inputMode="numeric"
                  value={value.count}
                  onChange={(e) => set({ count: Math.min(25, Math.max(1, Number(e.target.value) || 1)) })}
                />
              )}
            </Field>
          )}
          {value.mode === 'sticky' && (
            <Field label="Keep each IP for">
              {(id) => <Select id={id} value={value.sessionMinutes} onChange={(sessionMinutes) => set({ sessionMinutes })} options={KEEP_FOR} />}
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

function detectCountry(text: string): string | null {
  const m = text.match(/__(?:[^:@\s]*;)?cr\.([a-z]{2})/i);
  return m ? m[1].toLowerCase() : null;
}

const isProviderText = (text: string) => /dataimpulse\.com/i.test(text);

function TestResult({ result }: { result: TestProxyResult }) {
  const { check } = result;
  if (check.ok && check.info) {
    return (
      <p className="flex items-start gap-2 text-[13px] text-fiber-text" role="status">
        <CircleCheck className="mt-px size-4 shrink-0" aria-hidden />
        <span>
          Works. Exit IP <span className="font-mono">{check.info.ip}</span>
          {placeLine(check.info) ? ` in ${placeLine(check.info)}` : ''}
          {check.info.countryCode ? `, ${countryName(check.info.countryCode)}` : ''}
          {check.latencyMs ? ` (${check.latencyMs} ms)` : ''}.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-[13px] text-danger" role="alert">
      <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
      <span>{check.error ?? 'That proxy did not answer.'}</span>
    </p>
  );
}

/** Paste box. Used for first-run setup and for adding more proxies later. */
export function AddProxyForm({ submitLabel, onDone, onCancel }: { submitLabel: string; onDone?: () => void; onCancel?: () => void }) {
  const [text, setText] = useState('');
  const [options, setOptions] = useState(defaultExitOptions());
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestProxyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = isProviderText(text);

  const onText = (value: string) => {
    setText(value);
    setResult(null);
    setError(null);
    const cc = detectCountry(value);
    if (cc && cc !== options.country) setOptions((o) => ({ ...o, country: cc }));
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.testProxy({ text, mode: options.mode, country: provider ? options.country : undefined, city: provider ? options.city : undefined }));
    } catch (err) {
      toastError(err);
    } finally {
      setTesting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.addProxies({
        text,
        ...(provider
          ? { mode: options.mode, country: options.country, city: options.city, count: options.mode === 'sticky' ? options.count : 1, sessionMinutes: sessionMinutesOf(options) }
          : {}),
      });
      toast(`Added ${res.created} ${res.created === 1 ? 'IP' : 'IPs'}. Checking them now.`);
      if (res.invalid.length) toast(`Skipped ${res.invalid.length} line${res.invalid.length === 1 ? '' : 's'} that didn't look like a proxy.`, 'error');
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field label="Proxy login" error={error} hint="One per line. Also works: host:port:login:password and socks5://…">
        {(id, d) => (
          <Textarea
            id={id}
            aria-describedby={d}
            aria-invalid={Boolean(error)}
            value={text}
            onChange={(e) => onText(e.target.value)}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder="login:password@gw.dataimpulse.com:823"
            className="font-mono text-[13px]"
          />
        )}
      </Field>

      {provider && (
        <div className="flex flex-col gap-4 border-t border-line pt-5">
          <p className="text-[13px] text-ink-2">DataImpulse login found. Choose where your IPs come from.</p>
          <ExitOptions value={options} onChange={setOptions} showCount={options.mode === 'sticky'} />
        </div>
      )}

      {result && <TestResult result={result} />}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button onClick={test} disabled={!text.trim() || testing || saving}>
          {testing && <LoaderCircle className="animate-spin" aria-hidden />}
          {testing ? 'Testing' : 'Test'}
        </Button>
        <Button type="submit" variant="primary" disabled={!text.trim() || saving}>
          {saving ? 'Adding' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** "Add IPs": more exits from a saved provider login, or paste new proxies. */
export function AddIpsDialog({ state, open, onOpenChange }: { state: AppState; open: boolean; onOpenChange: (v: boolean) => void }) {
  const accounts = state.accounts;
  const [tab, setTab] = useState<'more' | 'paste'>(accounts.length ? 'more' : 'paste');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const lastCountry = [...state.exits].reverse().find((e) => e.kind === 'provider')?.lastCheck?.info?.countryCode?.toLowerCase();
  const [options, setOptions] = useState(defaultExitOptions(lastCountry ?? 'in'));
  const [saving, setSaving] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.createExits({
        accountId: accountId || accounts[0].id,
        mode: options.mode,
        country: options.country,
        city: options.city,
        count: options.mode === 'sticky' ? options.count : 1,
        sessionMinutes: sessionMinutesOf(options),
      });
      toast(`Added ${res.created} ${res.created === 1 ? 'IP' : 'IPs'}. Checking them now.`);
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add IPs" width={560}>
      {accounts.length > 0 && (
        <div className="mb-5">
          <Segmented
            label="Source"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'more', label: `From ${accounts.length === 1 ? accounts[0].name : 'a saved login'}` },
              { value: 'paste', label: 'Paste proxies' },
            ]}
          />
        </div>
      )}
      {tab === 'more' && accounts.length > 0 ? (
        <form onSubmit={create} className="flex flex-col gap-5">
          {accounts.length > 1 && (
            <Field label="Login">
              {(id) => (
                <Select
                  id={id}
                  value={accountId}
                  onChange={setAccountId}
                  options={accounts.map((a) => ({ value: a.id, label: `${a.name}: ${a.username.slice(0, 8)}…` }))}
                />
              )}
            </Field>
          )}
          <ExitOptions value={options} onChange={setOptions} showCount={options.mode === 'sticky'} />
          <DialogActions>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Adding' : options.mode === 'sticky' ? `Add ${options.count} ${options.count === 1 ? 'IP' : 'IPs'}` : 'Add rotating IP'}
            </Button>
          </DialogActions>
        </form>
      ) : (
        <AddProxyForm submitLabel="Add" onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

export function EditExitDialog({ exit, onClose }: { exit: Exit; onClose: () => void }) {
  const [name, setName] = useState(exit.name);
  const [options, setOptions] = useState<ExitOptionsValue>(
    exit.kind === 'provider'
      ? { country: exit.country ?? '', city: exit.city ?? '', mode: exit.mode, count: 1, sessionMinutes: exit.sessionMinutes ? String(exit.sessionMinutes) : 'default' }
      : defaultExitOptions(),
  );
  const [proxy, setProxy] = useState(exit.kind === 'proxy' ? { ...exit.proxy, username: exit.proxy.username ?? '', password: exit.proxy.password ?? '' } : null);
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (exit.kind === 'provider') {
        await api.updateExit(exit.id, {
          name,
          mode: options.mode,
          country: options.country,
          city: options.city,
          sessionMinutes: sessionMinutesOf(options) ?? null,
        });
      } else if (proxy) {
        await api.updateExit(exit.id, { name, proxy: { ...proxy, port: Number(proxy.port) } });
      }
      toast('Saved');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Edit ${exit.name}`} width={560}>
      <form onSubmit={save} className="flex flex-col gap-5">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}</Field>
        {exit.kind === 'provider' && (
          <>
            <ExitOptions value={options} onChange={setOptions} showCount={false} />
            <p className="text-[12px] text-ink-3">Changing the location or behaviour gives this slot a new IP.</p>
          </>
        )}
        {proxy && <ProxyFields value={proxy} onChange={setProxy} />}
        <DialogActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? 'Saving' : 'Save changes'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

interface ProxyFieldValues {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

const PROTOCOL_OPTIONS: { value: ProxyProtocol; label: string }[] = [
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS (TLS to proxy)' },
  { value: 'socks5', label: 'SOCKS5' },
];

function ProxyFields({ value, onChange, usernameLabel = 'Username' }: { value: ProxyFieldValues; onChange: (v: ProxyFieldValues) => void; usernameLabel?: string }) {
  const [show, setShow] = useState(false);
  const set = (patch: Partial<ProxyFieldValues>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
      <Field label="Host">{(id) => <Input id={id} value={value.host} onChange={(e) => set({ host: e.target.value.trim() })} spellCheck={false} className="font-mono text-[13px]" />}</Field>
      <Field label="Port">
        {(id) => <Input id={id} value={value.port || ''} inputMode="numeric" onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) })} className="font-mono text-[13px]" />}
      </Field>
      <Field label={usernameLabel}>
        {(id) => <Input id={id} value={value.username} onChange={(e) => set({ username: e.target.value })} spellCheck={false} autoComplete="off" className="font-mono text-[13px]" />}
      </Field>
      <Field label="Protocol">{(id) => <Select id={id} value={value.protocol} onChange={(protocol) => set({ protocol })} options={PROTOCOL_OPTIONS} />}</Field>
      <Field label="Password" className="sm:col-span-2">
        {(id) => (
          <div className="relative">
            <Input
              id={id}
              type={show ? 'text' : 'password'}
              value={value.password}
              onChange={(e) => set({ password: e.target.value })}
              autoComplete="off"
              className="pr-10 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide password' : 'Show password'}
              className="absolute top-0.5 right-0.5 flex size-8 items-center justify-center rounded-sm text-ink-3 hover:text-ink"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        )}
      </Field>
    </div>
  );
}

export function EditAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const [name, setName] = useState(account.name);
  const [fields, setFields] = useState<ProxyFieldValues>({
    protocol: account.protocol,
    host: account.host,
    port: account.port,
    username: account.username,
    password: account.password,
  });
  const [saving, setSaving] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateAccount(account.id, { name, ...fields });
      toast('Saved. Rechecking its IPs.');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Edit ${account.name} login`} description="Used by every IP from this login." width={560}>
      <form onSubmit={save} className="flex flex-col gap-5">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}</Field>
        <ProxyFields value={fields} onChange={setFields} usernameLabel="Login" />
        <DialogActions>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving' : 'Save changes'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

