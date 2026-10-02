import { darwinProxy } from './darwin';
import { linuxProxy } from './linux';
import { windowsProxy } from './win32';

/** Whatever a driver needs to put the user's previous settings back. */
export interface ProxySnapshot {
  platform: string;
  data: unknown;
}

export interface SystemProxyDriver {
  apply(host: string, port: number, bypass: string[]): Promise<ProxySnapshot>;
  restore(snapshot: ProxySnapshot): Promise<void>;
}

export function systemProxyDriver(): SystemProxyDriver | null {
  switch (process.platform) {
    case 'darwin':
      return darwinProxy;
    case 'win32':
      return windowsProxy;
    case 'linux':
      return linuxProxy;
    default:
      return null;
  }
}
