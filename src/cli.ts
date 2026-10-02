// Web mode: runs the app headless and serves the UI on http://127.0.0.1:8898.
// Same core and config as the desktop app.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Core } from './core/core';
import { randomToken } from './core/secure';
import { startControlServer, type ControlServer } from './core/server';
import { defaultDataDir } from './core/store';

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

if (flag('help') || flag('h')) {
  console.log(`Proxy App ${VERSION}

Usage: proxy-app [--port 8898] [--data-dir <dir>] [--no-open]

  --port       Port for the web UI (default 8898). The proxy gateway port is set in the app.
  --data-dir   Where config.json lives (default: same folder as the desktop app)
  --no-open    Don't open a browser tab`);
  process.exit(0);
}

const dev = flag('dev');
const dataDir = arg('data-dir') ?? defaultDataDir();
const uiPort = Number(arg('port') ?? 8898);

async function listen(core: Core): Promise<ControlServer> {
  const token = dev ? 'dev-token' : randomToken();
  const uiDir = dev ? null : path.join(__dirname, 'ui');
  for (let port = uiPort; port < uiPort + 10; port++) {
    try {
      return await startControlServer({ core, port, uiDir, token });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || dev) throw err;
    }
  }
  throw new Error(`Ports ${uiPort}-${uiPort + 9} are all busy. Pass --port to pick another.`);
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main() {
  const extensionSource = dev ? path.resolve('extension') : path.join(__dirname, 'extension');
  const core = new Core({ dataDir, shell: 'web', version: VERSION, extensionSource });
  await core.init();
  const server = await listen(core);
  const gatewayPort = core.getState().settings.gatewayPort;

  console.log(`
  Proxy App ${VERSION} is running

  Open      ${dev ? 'http://localhost:5173/  (Vite dev server)' : server.url}
  Gateway   127.0.0.1:${gatewayPort}  (HTTP + SOCKS5, once you connect)
  Config    ${path.join(dataDir, 'config.json')}

  Press Ctrl+C to stop. Your previous system proxy settings come back on exit.
`);
  if (!dev && !flag('no-open')) openBrowser(server.url);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n  Stopping. Restoring system proxy settings…');
    await core.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

main().catch((err) => {
  console.error(`\n  Proxy App couldn't start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
