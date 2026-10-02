import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { Core } from '../core/core';
import type { UpdateState } from '../shared/types';

const RELEASES = 'https://github.com/big-forge/big-proxy/releases/latest';
const EVERY = 6 * 60 * 60_000;

/**
 * Updates from GitHub Releases. Windows downloads and installs by itself.
 * macOS can only swap in a new app that is signed with a Developer ID, which our
 * builds aren't yet, so there we tell the user and open the download page.
 */
export function setupUpdater(core: Core, beforeInstall: () => void) {
  const canInstall = process.platform !== 'darwin' || process.env.PROXY_APP_SIGNED === '1';
  let state: UpdateState = { status: 'idle', canInstall };
  let manual = false;
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    core.setUpdate(state);
  };
  set({});

  // Only packaged builds have somewhere to update from.
  if (!app.isPackaged) return { check() {}, install() {}, openPage: () => void shell.openExternal(RELEASES) };

  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => set({ status: 'none', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => set({ status: canInstall ? 'downloading' : 'available', version: info.version, progress: 0, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, progress: 100 }));
  autoUpdater.on('error', (err) => {
    // Background checks fail quietly (offline, rate limit); a button press gets the reason.
    if (manual) set({ status: 'error', error: err.message.split('\n')[0].slice(0, 160) });
    else set({ status: 'idle' });
  });

  const check = () => {
    manual = true;
    void autoUpdater.checkForUpdates().catch(() => {}).finally(() => (manual = false));
  };
  const background = () => {
    manual = false;
    void autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(background, 15_000);
  setInterval(background, EVERY).unref();

  return {
    check,
    install() {
      if (state.status !== 'ready') return;
      beforeInstall();
      autoUpdater.quitAndInstall();
    },
    openPage: () => void shell.openExternal(RELEASES),
  };
}
