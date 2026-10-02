import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { Core } from '../core/core';
import type { AppState } from '../shared/types';

const MAX_EXITS_IN_MENU = 15;

/** Menu bar (macOS) / notification area (Windows) control: connect, switch, new IP. */
export class AppTray {
  private tray: Tray;
  private icons: { on: Electron.NativeImage; off: Electron.NativeImage };
  private lastKey = '';

  constructor(
    private readonly core: Core,
    assets: string,
    private readonly actions: { show(): void; quit(): void; toggle(bounds: Electron.Rectangle): void },
  ) {
    if (process.platform === 'darwin') {
      const on = nativeImage.createFromPath(path.join(assets, 'trayOnTemplate.png'));
      const off = nativeImage.createFromPath(path.join(assets, 'trayOffTemplate.png'));
      on.setTemplateImage(true);
      off.setTemplateImage(true);
      this.icons = { on, off };
    } else {
      this.icons = {
        on: nativeImage.createFromPath(path.join(assets, 'tray-on.png')),
        off: nativeImage.createFromPath(path.join(assets, 'tray-off.png')),
      };
    }
    this.tray = new Tray(this.icons.off);
    this.tray.setToolTip('Proxy App');
    // macOS and Windows: click opens the designed popover, right-click the plain menu. Linux trays only reliably do menus.
    if (process.platform === 'linux') return;
    this.tray.on('click', (_e, bounds) => actions.toggle(bounds));
    this.tray.on('right-click', () => this.menu && this.tray.popUpContextMenu(this.menu));
  }

  private menu: Menu | null = null;

  get bounds(): Electron.Rectangle {
    return this.tray.getBounds();
  }

  update(state: AppState) {
    const active = state.exits.find((e) => e.id === state.activeExitId);
    // Rebuilding a native menu is cheap, but skip it when nothing visible changed.
    const key = JSON.stringify([state.status, state.activeExitId, state.checking, state.exits.map((e) => [e.id, e.name, e.lastCheck?.info?.ip])]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    const on = state.status === 'on';
    const ip = active?.lastCheck?.info?.ip;
    this.tray.setImage(on ? this.icons.on : this.icons.off);
    this.tray.setToolTip(on ? `Proxy App: connected${ip ? ` via ${ip}` : ''}` : 'Proxy App: not connected');

    const canRotate = active?.kind === 'provider' && active.mode === 'sticky';
    const run = (fn: () => Promise<unknown>) => () => void fn().catch(() => {});
    const template: MenuItemConstructorOptions[] = [
      { label: on ? `Connected${ip ? `: ${ip}` : ''}` : state.status === 'connecting' ? 'Connecting…' : 'Not connected', enabled: false },
      on
        ? { label: 'Disconnect', click: run(() => this.core.disconnect()) }
        : { label: 'Connect', enabled: Boolean(active), click: run(() => this.core.connect()) },
      { type: 'separator' },
      ...state.exits.slice(0, MAX_EXITS_IN_MENU).map(
        (exit): MenuItemConstructorOptions => ({
          type: 'radio',
          label: exit.lastCheck?.info?.ip ? `${exit.name}    ${exit.lastCheck.info.ip}` : exit.name,
          checked: exit.id === state.activeExitId,
          click: run(() => this.core.activateExit(exit.id)),
        }),
      ),
      ...(state.exits.length > MAX_EXITS_IN_MENU ? [{ label: `${state.exits.length - MAX_EXITS_IN_MENU} more in the app…`, click: this.actions.show }] : []),
      ...(state.exits.length ? [{ type: 'separator' as const }] : []),
      {
        label: active && state.checking.includes(active.id) ? 'Getting a new IP…' : 'New IP',
        enabled: canRotate,
        click: run(() => this.core.rotateExit(active!.id)),
      },
      { type: 'separator' },
      { label: 'Open Proxy App', click: this.actions.show },
      { label: 'Quit Proxy App', click: this.actions.quit },
    ];
    this.menu = Menu.buildFromTemplate(template);
    if (process.platform === 'linux') this.tray.setContextMenu(this.menu);
  }
}
