import type { AppState } from '../../shared/types';
import { Logo } from '../components/brand';
import { Panel } from '../components/ui';
import { AddProxyForm } from './forms';

export function Onboarding({ state }: { state: AppState }) {
  return (
    <div className="mx-auto flex max-w-[600px] flex-col px-4 py-10 sm:py-16">
      <Logo className="size-9 text-ink" />
      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.015em] text-ink">Add your proxy</h1>
      <p className="mt-2 max-w-[52ch] text-sm text-ink-2">
        Paste the login from your proxy provider. Proxy App turns it into IPs you can switch between in one click, for this computer and your phone.
      </p>
      <Panel className="mt-8 p-5">
        <AddProxyForm submitLabel="Add and continue" />
      </Panel>
      <p className="mt-4 text-[12px] text-ink-3">
        Your login is stored only on this computer, in <span className="font-mono break-all">{state.dataDir}</span>.
      </p>
    </div>
  );
}
