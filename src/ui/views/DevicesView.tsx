import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AppState } from '../../shared/types';
import { toast, toastError } from '../components/Toaster';
import { Button, Field, IconButton, Input, Notice, PageHeader, Panel, Row, Segmented, Switch } from '../components/ui';
import { api } from '../lib/api';

type Guide = 'iphone' | 'android' | 'computer' | 'auto';

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex h-11 items-center justify-between gap-2 rounded-sm border border-line bg-sunken pr-1 pl-3">
      <span className="truncate font-mono text-[15px] text-ink">{value}</span>
      <IconButton
        label={copied ? 'Copied' : `Copy ${label}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="text-fiber-text" /> : <Copy />}
      </IconButton>
    </div>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-[13px] text-ink-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-ink-2 tabular-nums">{i + 1}</span>
          <span className="pt-px">{item}</span>
        </li>
      ))}
    </ol>
  );
}

const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-ink">{children}</span>;

export function DevicesView({ state }: { state: AppState }) {
  const s = state.settings;
  const ip = state.lanAddresses[0];
  const port = String(s.gatewayPort);
  const [guide, setGuide] = useState<Guide>('iphone');
  const [auth, setAuth] = useState(s.lanAuth);
  const authDirty = auth.username !== s.lanAuth.username || auth.password !== s.lanAuth.password;

  const saveAuth = async (enabled: boolean) => {
    try {
      await api.updateSettings({ lanAuth: { ...auth, enabled } });
      setAuth((a) => ({ ...a, enabled }));
      toast(enabled ? 'Devices now need the login' : 'Login no longer required');
    } catch (err) {
      toastError(err);
    }
  };

  const needsLogin = s.lanAuth.enabled;

  return (
    <div className="mx-auto max-w-[780px] px-4 py-6 sm:px-6">
      <PageHeader
        title="Phones and other devices"
        description="Devices on the same Wi-Fi can send their traffic through this computer. When you switch IP here, they switch too."
      />

      <Panel className="px-4">
        <Row
          title="Allow devices on my network"
          description={state.status === 'on' ? 'Only devices on your local network or Tailscale can connect.' : 'Works while Proxy App is connected.'}
        >
          <Switch label="Allow devices on my network" checked={s.allowLan} onChange={(allowLan) => api.updateSettings({ allowLan }).catch(toastError)} />
        </Row>
      </Panel>

      {s.allowLan && (
        <>
          {!ip ? (
            <div className="mt-5">
              <Notice tone="warn">This computer isn't on a local network right now. Join Wi-Fi or Ethernet, then come back.</Notice>
            </div>
          ) : (
            <>
              <Panel className="mt-5 p-4">
                <h2 className="text-sm font-semibold text-ink">Proxy address for your devices</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px]">
                  <div>
                    <div className="mb-1.5 text-[13px] font-medium text-ink">Server</div>
                    <CopyValue value={ip} label="server" />
                  </div>
                  <div>
                    <div className="mb-1.5 text-[13px] font-medium text-ink">Port</div>
                    <CopyValue value={port} label="port" />
                  </div>
                </div>
                {state.lanAddresses.length > 1 && (
                  <p className="mt-3 text-[12px] text-ink-3">
                    Other addresses for this computer: <span className="font-mono">{state.lanAddresses.slice(1).join(', ')}</span>
                  </p>
                )}
                {state.status !== 'on' && (
                  <div className="mt-4">
                    <Notice tone="info">Connect on the Connect tab first. Devices can't use the proxy while it's off.</Notice>
                  </div>
                )}
              </Panel>

              <Panel className="mt-5 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-sm font-semibold text-ink">Set it up</h2>
                  <Segmented
                    label="Device"
                    value={guide}
                    onChange={setGuide}
                    options={[
                      { value: 'iphone', label: 'iPhone' },
                      { value: 'android', label: 'Android' },
                      { value: 'computer', label: 'Computer' },
                      { value: 'auto', label: 'Automatic' },
                    ]}
                  />
                </div>
                <div className="mt-5">
                  {guide === 'iphone' && (
                    <Steps
                      items={[
                        'Open Settings, then Wi-Fi.',
                        <>Tap the ⓘ next to the network you're on (the same one as this computer).</>,
                        'Scroll down to Configure Proxy and choose Manual.',
                        <>
                          Server <Mono>{ip}</Mono>, Port <Mono>{port}</Mono>.
                          {needsLogin && <> Turn on Authentication and enter the login below.</>}
                        </>,
                        'Tap Save. Safari and most apps now use the proxy.',
                      ]}
                    />
                  )}
                  {guide === 'android' && (
                    <Steps
                      items={[
                        'Open Settings, then Network & internet (or Connections), then Wi-Fi.',
                        'Tap the gear or long-press the network you are on, then Edit or Modify.',
                        'Open Advanced options and set Proxy to Manual.',
                        <>
                          Proxy hostname <Mono>{ip}</Mono>, Proxy port <Mono>{port}</Mono>. Save.
                        </>,
                        "Chrome and most apps follow it. A few apps ignore the Wi-Fi proxy; that's Android, not Proxy App.",
                      ]}
                    />
                  )}
                  {guide === 'computer' && (
                    <Steps
                      items={[
                        <>
                          In the system or browser proxy settings, use <Mono>{`${ip}:${port}`}</Mono> as the HTTP and HTTPS proxy (or as SOCKS5).
                        </>,
                        needsLogin ? 'Enter the login below when asked.' : 'No login needed.',
                        'Or install Proxy App on that computer too and add the same proxy login. Each copy switches on its own.',
                      ]}
                    />
                  )}
                  {guide === 'auto' && (
                    <Steps
                      items={[
                        'Use this when a device supports "Automatic" proxy (iPhone, Android, Windows, macOS).',
                        <>
                          Enter this URL: <Mono>{`http://${ip}:${port}/proxy.pac`}</Mono>
                        </>,
                        'Local addresses (your router, printers) keep working without the proxy.',
                      ]}
                    />
                  )}
                </div>
              </Panel>

              <Panel className="mt-5 px-4">
                <Row
                  title="Require a login"
                  description="Stops anyone else on a shared Wi-Fi from using your proxy. Android's Wi-Fi setting can't send a login, so leave this off for Android phones."
                >
                  <Switch label="Require a login" checked={s.lanAuth.enabled} onChange={saveAuth} disabled={!s.lanAuth.enabled && !auth.password} />
                </Row>
                <div className="grid gap-4 border-t border-line py-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <Field label="Username">{(id) => <Input id={id} value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} autoComplete="off" />}</Field>
                  <Field label="Password">
                    {(id) => <Input id={id} value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} autoComplete="new-password" placeholder="Pick a password" />}
                  </Field>
                  <Button disabled={!authDirty || (s.lanAuth.enabled && !auth.password)} onClick={() => saveAuth(s.lanAuth.enabled)}>
                    Save login
                  </Button>
                </div>
              </Panel>
            </>
          )}

          <p className="mt-5 text-[12px] text-ink-3">
            Device can't connect? Allow Proxy App through the firewall. macOS asks the first time; on Windows allow it on Private networks.
          </p>
        </>
      )}
    </div>
  );
}
