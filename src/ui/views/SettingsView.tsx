import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Account, AppState } from '../../shared/types';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { Select } from '../components/Select';
import { toast, toastError } from '../components/Toaster';
import { Button, Input, PageHeader, Panel, Row, Segmented, Switch, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { bytes } from '../lib/format';
import { AddProxyForm, EditAccountDialog } from './forms';

const ROTATE = [
  { value: '0', label: 'Off' },
  { value: '5', label: 'Every 5 min' },
  { value: '10', label: 'Every 10 min' },
  { value: '15', label: 'Every 15 min' },
  { value: '30', label: 'Every 30 min' },
  { value: '60', label: 'Every hour' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="mb-2 text-[13px] font-semibold text-ink-2">{title}</h2>
      <Panel className="divide-y divide-line px-4">{children}</Panel>
    </section>
  );
}

export function SettingsView({ state }: { state: AppState }) {
  const s = state.settings;
  const save = (patch: Partial<typeof s>, message?: string) =>
    api
      .updateSettings(patch)
      .then(() => message && toast(message))
      .catch(toastError);

  const [port, setPort] = useState(String(s.gatewayPort));
  const [bypass, setBypass] = useState(s.bypass.join('\n'));
  const [editing, setEditing] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const desktop = state.shell === 'desktop';

  return (
    <div className="mx-auto max-w-[780px] px-4 py-6 sm:px-6">
      <PageHeader title="Settings" />

      <Section title="Proxy logins">
        {state.accounts.length === 0 && <Row title="No provider logins" description="Plain proxies you pasted are managed from the IP list." />}
        {state.accounts.map((a) => {
          const count = state.exits.filter((e) => e.kind === 'provider' && e.accountId === a.id).length;
          return (
            <Row
              key={a.id}
              title={a.name}
              description={
                <>
                  <span className="font-mono">{`${a.username.slice(0, 10)}…@${a.host}:${a.port}`}</span>
                  <span className="ml-2">
                    {count} {count === 1 ? 'IP' : 'IPs'}
                  </span>
                </>
              }
            >
              <Button size="sm" onClick={() => setEditing(a)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(a)}>
                Remove
              </Button>
            </Row>
          );
        })}
        <Row title="Add a proxy" description="DataImpulse logins, or plain proxies from any provider.">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add proxy
          </Button>
        </Row>
      </Section>

      <Section title="Switching">
        <Row title="Move open connections on switch" description="Every app jumps to the new IP at once. Turn off to let downloads finish on the old IP.">
          <Switch label="Move open connections on switch" checked={s.dropOnSwitch} onChange={(dropOnSwitch) => save({ dropOnSwitch })} />
        </Row>
        <Row title="Get a new IP automatically" description="For the sticky IP in use, while connected.">
          <div className="w-44">
            <Select
              label="Get a new IP automatically"
              value={String(s.autoRotateMinutes)}
              onChange={(v) => save({ autoRotateMinutes: Number(v) })}
              options={ROTATE.some((r) => r.value === String(s.autoRotateMinutes)) ? ROTATE : [...ROTATE, { value: String(s.autoRotateMinutes), label: `Every ${s.autoRotateMinutes} min` }]}
            />
          </div>
        </Row>
      </Section>

      <Section title="Gateway">
        <Row title="Port" description={`Apps connect to 127.0.0.1:${s.gatewayPort}. Change it if another app already uses this port.`}>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save({ gatewayPort: Number(port) }, 'Port updated');
            }}
          >
            <Input aria-label="Gateway port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="w-24 font-mono" />
            <Button type="submit" size="md" disabled={port === String(s.gatewayPort) || !port}>
              Save
            </Button>
          </form>
        </Row>
        <Row title="Route this whole computer" description="Set the system proxy while connected. The previous settings come back when you disconnect or quit.">
          <Switch label="Route this whole computer" checked={s.systemProxy} onChange={(systemProxy) => save({ systemProxy })} />
        </Row>
        <div className="flex flex-col gap-3 py-4">
          <div>
            <div className="text-sm font-medium text-ink">Never use the proxy for</div>
            <div className="mt-0.5 text-[13px] text-ink-3">One per line. Local addresses always go direct.</div>
          </div>
          <Textarea aria-label="Bypass list" value={bypass} onChange={(e) => setBypass(e.target.value)} rows={5} spellCheck={false} className="font-mono text-[12px]" />
          <div className="flex justify-end">
            <Button size="sm" disabled={bypass === s.bypass.join('\n')} onClick={() => save({ bypass: bypass.split('\n') }, 'Bypass list saved')}>
              Save list
            </Button>
          </div>
        </div>
      </Section>

      <Section title="App">
        <Row title="Connect when Proxy App starts">
          <Switch label="Connect when Proxy App starts" checked={s.startConnected} onChange={(startConnected) => save({ startConnected })} />
        </Row>
        {desktop && (
          <Row title="Open at login" description="Starts in the menu bar / system tray.">
            <Switch label="Open at login" checked={s.launchAtLogin} onChange={(launchAtLogin) => save({ launchAtLogin })} />
          </Row>
        )}
        <Row title="Appearance">
          <Segmented
            label="Appearance"
            value={s.theme}
            onChange={(theme) => save({ theme })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
      </Section>

      <Section title="Data">
        <Row
          title="Traffic through Proxy App"
          description={`${bytes(state.usage.up + state.usage.down)} since ${new Date(state.usage.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. Your provider's dashboard is the source of truth for billing.`}
        >
          <Button size="sm" variant="ghost" onClick={() => api.resetUsage().catch(toastError)}>
            Reset
          </Button>
        </Row>
        <Row
          title="Where your logins are kept"
          description={
            <>
              Only on this computer, in <span className="font-mono break-all">{state.dataDir}</span>
            </>
          }
        />
        <Row title="Version" description={<UpdateLine state={state} />}>
          {desktop && <UpdateButton state={state} />}
        </Row>
      </Section>

      {editing && <EditAccountDialog account={editing} onClose={() => setEditing(null)} />}
      <Dialog open={adding} onOpenChange={setAdding} title="Add proxy" width={560}>
        <AddProxyForm submitLabel="Add" onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={`Remove the ${removing?.name} login?`}
        description="All IPs that use this login are removed too."
        confirmLabel="Remove login"
        onConfirm={async () => {
          if (removing) await api.deleteAccount(removing.id).catch(toastError);
        }}
      />
    </div>
  );
}

function UpdateLine({ state }: { state: AppState }) {
  const u = state.update;
  let text = `Proxy App ${state.version}. Open source, MIT licence.`;
  if (u?.status === 'checking') text = `Proxy App ${state.version}. Checking for updates…`;
  else if (u?.status === 'none') text = `Proxy App ${state.version}. You have the latest version.`;
  else if (u?.status === 'downloading') text = `Downloading ${u.version ?? 'the update'}… ${u.progress ?? 0}%`;
  else if (u?.status === 'ready') text = `${u.version} is ready. Restart Proxy App to finish updating.`;
  else if (u?.status === 'available') text = `${u.version} is available. This Mac build can't update itself yet, so download it and replace the app.`;
  else if (u?.status === 'error') text = `Couldn't check for updates: ${u.error}`;
  return <span className={u?.status === 'error' ? 'text-danger' : undefined}>{text}</span>;
}

function UpdateButton({ state }: { state: AppState }) {
  const u = state.update;
  if (!u) return null;
  if (u.status === 'ready') return <Button size="sm" variant="primary" onClick={() => api.shell('updateInstall').catch(toastError)}>Restart to update</Button>;
  if (u.status === 'available') return <Button size="sm" variant="primary" onClick={() => api.shell('updatePage').catch(toastError)}>Download {u.version}</Button>;
  return (
    <Button size="sm" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => api.shell('updateCheck').catch(toastError)}>
      Check for updates
    </Button>
  );
}
