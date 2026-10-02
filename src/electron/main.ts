import { app, BrowserWindow, Menu, nativeImage, nativeTheme, powerMonitor, screen, shell } from 'electron';
import path from 'node:path';
import { Core } from '../core/core';
import { randomToken } from '../core/secure';
import { startControlServer, type ControlServer } from '../core/server';
import { defaultDataDir } from '../core/store';
import type { AppState } from '../shared/types';
import { AppTray } from './tray';
import { setupUpdater } from './updater';

const REPO_URL = 'https://github.com/big-forge/big-proxy';
const isMac = process.platform === 'darwin';
const assets = path.join(__dirname, 'assets');

// One config folder for desktop and CLI. Must be set before `ready`.
const dataDir = defaultDataDir();
app.setName('Proxy App');
app.setPath('userData', dataDir);

let core: Core;
let server: ControlServer;
let win: BrowserWindow | null = null;
let popover: BrowserWindow | null = null;
let updater: ReturnType<typeof setupUpdater>;
let popoverShownAt = 0;
let tray: AppTray | null = null;
let quitting = false;
let cleanedUp = false;
let loginItem: boolean | null = null;

const COLORS = {
  dark: { bg: '#0f1215', fg: '#e6eaed' },
  light: { bg: '#f4f6f7', fg: '#11171c' },
};

function palette() {
  return nativeTheme.shouldUseDarkColors ? COLORS.dark : COLORS.light;
}

function startedHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  return isMac && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function createWindow() {
  const { bg, fg } = palette();
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Proxy App',
    backgroundColor: bg,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 18, y: 17 } : undefined,
    titleBarOverlay: isMac ? undefined : { color: bg, symbolColor: fg, height: 48 },
    icon: isMac ? undefined : path.join(assets, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL(server.url);
  win.once('ready-to-show', () => {
    if (!startedHidden()) win?.show();
  });
  win.on('close', (e) => {
    // Closing the window keeps the proxy running from the tray / menu bar.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(server.url)) e.preventDefault();
  });
  // Windows: a forced logoff can't wait for us, so restore the proxy right away.
  win.on('session-end', () => void core.shutdown());
}

const POPOVER_WIDTH = 320;

/** The designed menu: a small frameless window under the tray icon that closes when you click elsewhere. */
function createPopover() {
  const { bg } = palette();
  const w = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: bg,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.loadURL(`${server.url}#tray`);
  w.on('blur', () => {
    // The click that opened it also blurs the tray; give it a beat.
    if (Date.now() - popoverShownAt > 250) w.hide();
  });
  w.on('closed', () => (popover = null));
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return w;
}

/** Fits the window to its content (the list grows and shrinks) and keeps it on screen under the icon. */
async function placePopover(w: BrowserWindow, bounds: Electron.Rectangle) {
  const height = await w.webContents
    .executeJavaScript('document.getElementById("tray-root")?.offsetHeight ?? 0')
    .then((h: number) => Math.min(Math.max(h, 160), 640))
    .catch(() => 420);
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const area = display.workArea;
  const x = Math.round(Math.min(Math.max(bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2, area.x + 8), area.x + area.width - POPOVER_WIDTH - 8));
  // Menu bar on top (macOS): open below it. Taskbar on the bottom (Windows): open above it.
  const below = bounds.y < area.y + area.height / 2;
  const y = below ? Math.round(bounds.y + bounds.height + 4) : Math.round(bounds.y - height - 4);
  w.setBounds({ x, y: Math.max(area.y, y), width: POPOVER_WIDTH, height });
}

async function togglePopover(bounds: Electron.Rectangle) {
  if (popover?.isVisible()) return popover.hide();
  popover ??= createPopover();
  const w = popover;
  if (w.webContents.isLoading()) await new Promise<void>((resolve) => w.webContents.once('did-finish-load' as 'zoom-changed', () => resolve()));
  // Let the freshest state render before measuring.
  await new Promise((r) => setTimeout(r, 120));
  await placePopover(w, bounds);
  popoverShownAt = Date.now();
  w.show();
  w.focus();
  // Content can change while open (IP list, new check): keep the height right.
  const fit = setInterval(() => (w.isDestroyed() || !w.isVisible() ? clearInterval(fit) : void placePopover(w, tray?.bounds ?? bounds)), 500);
}

function showWindow() {
  popover?.hide();
  if (!win) createWindow();
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
}

function applyNativeSettings(state: AppState) {
  const theme = state.settings.theme;
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  if (loginItem !== state.settings.launchAtLogin && app.isPackaged) {
    loginItem = state.settings.launchAtLogin;
    // Only touch the OS setting when it differs; macOS refuses for apps outside /Applications.
    if (app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin !== loginItem) {
      app.setLoginItemSettings({ openAtLogin: loginItem, args: ['--hidden'] });
    }
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ role: isMac ? ('close' as const) : ('quit' as const) }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Proxy App on GitHub', click: () => void shell.openExternal(REPO_URL) }] },
  ]);
}

async function cleanupAndQuit() {
  if (cleanedUp) return;
  quitting = true;
  // Never hang on quit: restore what we can within 5 seconds.
  await Promise.race([core?.shutdown(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
  await server?.close().catch(() => {});
  cleanedUp = true;
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    // Stay alive in the tray.
  });
  app.on('before-quit', (e) => {
    if (cleanedUp) return;
    e.preventDefault();
    void cleanupAndQuit();
  });

  app.whenReady().then(async () => {
    core = new Core({ dataDir, shell: 'desktop', version: app.getVersion(), extensionSource: path.join(__dirname, '..', 'extension').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
      iconProvider: async (file) => {
        // macOS: QuickLook gives the real icon (asset catalogs too); Windows: the shell icon.
        const img = isMac ? await nativeImage.createThumbnailFromPath(file, { width: 64, height: 64 }) : await app.getFileIcon(file, { size: 'normal' });
        return img.isEmpty() ? null : img.toPNG();
      },
    });
    await core.init();
    updater = setupUpdater(core, () => (quitting = true));
    server = await startControlServer({
      core,
      port: 0,
      uiDir: path.join(__dirname, '..', 'ui'),
      token: randomToken(),
      shell: {
        show: showWindow,
        quit: () => void cleanupAndQuit(),
        hide: () => popover?.hide(),
        updateCheck: () => updater.check(),
        updateInstall: () => updater.install(),
        updatePage: () => updater.openPage(),
      },
    });

    Menu.setApplicationMenu(buildMenu());
    tray = new AppTray(core, assets, { show: showWindow, quit: () => void cleanupAndQuit(), toggle: (b) => void togglePopover(b) });
    const state = core.getState();
    applyNativeSettings(state);
    tray.update(state);
    core.on('state', (s) => {
      applyNativeSettings(s);
      tray?.update(s);
    });

    nativeTheme.on('updated', () => {
      const { bg, fg } = palette();
      win?.setBackgroundColor(bg);
      popover?.setBackgroundColor(bg);
      if (!isMac) win?.setTitleBarOverlay({ color: bg, symbolColor: fg });
    });

    // macOS/Linux: delay shutdown long enough to put the proxy settings back.
    (powerMonitor as unknown as NodeJS.EventEmitter).on('shutdown', (e: Electron.Event) => {
      e.preventDefault();
      void cleanupAndQuit();
    });

    createWindow();
  });
}
