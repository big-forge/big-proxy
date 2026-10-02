import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ApiError, type Core } from './core';
import { randomToken, safeEqual } from './secure';
import type { BrowserId } from '../shared/types';

export interface ControlServerOptions {
  core: Core;
  port: number;
  /** Built UI to serve. Null when Vite serves the UI in development. */
  uiDir: string | null;
  token: string;
  /** Window controls, only in the desktop app. */
  shell?: { show(): void; quit(): void; hide(): void; updateCheck(): void; updateInstall(): void; updatePage(): void };
}

export interface ControlServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

type Handler = (ctx: { body: any; params: string[]; url: URL }) => unknown | Promise<unknown>;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/**
 * The control API the UI talks to. Bound to 127.0.0.1 only. Requests must
 * carry the per-launch token and a loopback Host header, which keeps
 * websites (CSRF, DNS rebinding) from driving it.
 */
export async function startControlServer({ core, port, uiDir, token, shell }: ControlServerOptions): Promise<ControlServer> {
  const routes: [method: string, pattern: RegExp, handler: Handler][] = [
    ['GET', /^\/api\/state$/, () => core.getState()],
    ['GET', /^\/api\/activity$/, () => core.getActivity()],
    ['DELETE', /^\/api\/activity$/, () => (core.clearActivity(), { ok: true })],
    ['POST', /^\/api\/connect$/, () => core.connect()],
    ['POST', /^\/api\/disconnect$/, () => core.disconnect()],
    ['POST', /^\/api\/proxies$/, ({ body }) => core.addProxies(body)],
    ['POST', /^\/api\/proxies\/test$/, ({ body }) => core.testProxy(body)],
    ['POST', /^\/api\/exits$/, ({ body }) => core.createExits(body)],
    ['POST', /^\/api\/exits\/check-all$/, () => (void core.checkMany(core.getState().exits.map((e) => e.id)), core.getState())],
    ['POST', /^\/api\/exits\/reorder$/, ({ body }) => core.reorderExits(Array.isArray(body.ids) ? body.ids : [])],
    ['PATCH', /^\/api\/exits\/([\w-]+)$/, ({ body, params }) => core.updateExit(params[0], body)],
    ['DELETE', /^\/api\/exits\/([\w-]+)$/, ({ params }) => core.deleteExit(params[0])],
    ['POST', /^\/api\/exits\/([\w-]+)\/activate$/, ({ params }) => core.activateExit(params[0])],
    ['POST', /^\/api\/exits\/([\w-]+)\/rotate$/, ({ params }) => core.rotateExit(params[0])],
    ['POST', /^\/api\/exits\/([\w-]+)\/check$/, ({ params }) => core.checkExit(params[0])],
    ['PATCH', /^\/api\/accounts\/([\w-]+)$/, ({ body, params }) => core.updateAccount(params[0], body)],
    ['DELETE', /^\/api\/accounts\/([\w-]+)$/, ({ params }) => core.deleteAccount(params[0])],
    ['PATCH', /^\/api\/settings$/, ({ body }) => core.updateSettings(body)],
    ['POST', /^\/api\/usage\/reset$/, () => core.resetUsage()],
    ['GET', /^\/api\/browsers$/, () => core.browserProfilesLive()],
    [
      'POST',
      /^\/api\/browsers\/open$/,
      ({ body }) => {
        const browser = String(body.browser) as BrowserId;
        core.openBrowserProfile(browser, String(body.dir), `http://127.0.0.1:${boundPort}/browser-setup?b=${encodeURIComponent(browser)}`);
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/extension\/reveal$/, () => (core.revealExtension(), { ok: true })],
    ['POST', /^\/api\/browsers\/firefox$/, ({ body }) => core.setFirefoxProxy(String(body.dir), Boolean(body.enabled))],
    [
      'POST',
      /^\/api\/browsers\/proxy$/,
      ({ body }) => core.setBrowserProfileProxy(String(body.browser) as BrowserId, String(body.dir), Boolean(body.enabled), body.exitId ? String(body.exitId) : null),
    ],
    ['GET', /^\/api\/apps$/, ({ url }) => core.listApps(url.searchParams.has('refresh'))],
    ['POST', /^\/api\/apps\/proxy$/, ({ body }) => core.setAppProxy(String(body.id), Boolean(body.enabled), body.exitId ? String(body.exitId) : null)],
    ['POST', /^\/api\/apps\/open$/, ({ body }) => core.openApp(String(body.id))],
    [
      'POST',
      /^\/api\/shell\/(show|quit|hide|updateCheck|updateInstall|updatePage)$/,
      ({ params }) => {
        if (!shell) throw new ApiError(404, 'Only in the desktop app');
        shell[params[0] as keyof typeof shell]();
        return { ok: true };
      },
    ],
    ['POST', /^\/api\/terminal$/, ({ body }) => core.openTerminal(body.exitId ? String(body.exitId) : null)],
  ];

  let indexHtml: string | null = null;
  const uiRoot = uiDir ? path.resolve(uiDir) : null;
  if (uiRoot) {
    const raw = fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8');
    indexHtml = raw.replace('</head>', `<meta name="proxy-app-token" content="${token}"></head>`);
  }

  let boundPort = port;
  core.setMaxListeners(50);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Misdirected request');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const given = String(req.headers['x-proxy-app-token'] ?? url.searchParams.get('token') ?? '');
      if (!safeEqual(given, token)) {
        sendJson(res, 401, { error: 'Not authorized. Reload the app.' });
        return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') return events(req, res, core);
      if (url.pathname === '/api/apps/icon' && req.method === 'GET') {
        const png = await core.appIcon(url.searchParams.get('id') ?? '').catch(() => null);
        if (!png) res.writeHead(404).end();
        else res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' }).end(png);
        return;
      }
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = url.pathname.match(pattern);
        if (!match) continue;
        try {
          const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
          const result = await handler({ body, params: match.slice(1), url });
          sendJson(res, 200, result ?? { ok: true });
        } catch (err) {
          const status = err instanceof ApiError ? err.status : err instanceof SyntaxError ? 400 : 500;
          sendJson(res, status, { error: err instanceof Error ? err.message : 'Something went wrong' });
        }
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Opened inside the browser profile being set up, so the steps are where the user acts.
    if (url.pathname === '/browser-setup' && req.method === 'GET') {
      const nonce = randomToken(12);
      res
        .writeHead(200, {
          ...SECURITY_HEADERS,
          'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'content-type': TYPES['.html'],
          'cache-control': 'no-store',
        })
        .end(setupPage(url.searchParams.get('b') ?? 'chrome', core.extensionDir, nonce));
      return;
    }

    if (!uiRoot || !indexHtml || req.method !== 'GET') {
      res.writeHead(404).end();
      return;
    }
    const file = path.resolve(uiRoot, '.' + decodeURIComponent(url.pathname));
    if (file.startsWith(uiRoot + path.sep) && path.basename(file) !== 'index.html' && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const immutable = url.pathname.startsWith('/assets/');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES['.html'], 'cache-control': 'no-store' }).end(indexHtml);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new ApiError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function events(req: http.IncomingMessage, res: http.ServerResponse, core: Core) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('state', core.getState());
  const onState = (s: unknown) => send('state', s);
  const onStats = (s: unknown) => send('stats', s);
  const onActivity = (a: unknown) => send('activity', a);
  core.on('state', onState);
  core.on('stats', onStats);
  core.on('activity', onActivity);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    core.off('state', onState);
    core.off('stats', onStats);
    core.off('activity', onActivity);
  });
}

const EXTENSION_PAGES: Record<string, string> = { chrome: 'chrome://extensions', edge: 'edge://extensions', brave: 'brave://extensions', chromium: 'chrome://extensions' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function setupPage(browser: string, extensionDir: string, nonce: string): string {
  const page = EXTENSION_PAGES[browser] ?? EXTENSION_PAGES.chrome;
  const mac = process.platform === 'darwin';
  const dir = escapeHtml(extensionDir);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Proxy App in this profile</title>
<style>
  :root { --bg:#f4f6f7; --card:#fff; --ink:#11171c; --ink2:#48535d; --ink3:#66717b; --line:rgba(15,23,30,.1); --sunken:#eef1f3; --fiber:#0b7d73; --fiber-ink:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1215; --card:#151a1e; --ink:#e6eaed; --ink2:#a4aeb7; --ink3:#808b95; --line:rgba(255,255,255,.08); --sunken:#0c0f12; --fiber:#35c6b8; --fiber-ink:#04211e; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:640px; margin:48px auto; padding:0 16px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
  p.lead { color:var(--ink2); margin:0 0 28px; }
  ol { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  li { display:flex; gap:14px; padding:18px 20px; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  .n { flex:none; width:24px; height:24px; border-radius:50%; background:var(--sunken); color:var(--ink2); font-size:12px; font-weight:600; display:flex; align-items:center; justify-content:center; margin-top:1px; }
  .t { min-width:0; flex:1; }
  .t b { font-weight:600; }
  .hint { color:var(--ink3); font-size:13px; margin-top:6px; }
  .copy { display:flex; align-items:center; gap:8px; margin-top:10px; background:var(--sunken); border:1px solid var(--line); border-radius:6px; padding:6px 6px 6px 12px; }
  code { font:13px ui-monospace,"SF Mono",Menlo,Consolas,monospace; overflow-wrap:anywhere; flex:1; }
  button { flex:none; height:32px; padding:0 12px; border-radius:6px; border:0; background:var(--fiber); color:var(--fiber-ink); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  button:active { transform:scale(.97); }
  footer { color:var(--ink3); font-size:13px; margin-top:20px; }
</style></head>
<body><main>
  <h1>Use Proxy App in this profile</h1>
  <p class="lead">Takes a minute, once. Only this profile will use your proxy. Other profiles and apps keep your normal connection.</p>
  <ol>
    <li><span class="n">1</span><div class="t">Copy this, paste it in the address bar above, and press Enter.
      <div class="copy"><code>${page}</code><button data-copy="${page}">Copy</button></div></div></li>
    <li><span class="n">2</span><div class="t">Turn on <b>Developer mode</b> in the top-right corner of that page.</div></li>
    <li><span class="n">3</span><div class="t">Click <b>Load unpacked</b> and choose this folder:
      <div class="copy"><code>${dir}</code><button data-copy="${dir}">Copy</button></div>
      <div class="hint">${mac ? 'In the folder picker, press ⌘ ⇧ G, paste the path, then click Select.' : 'In the folder picker, paste the path into the address bar at the top, then click Select Folder.'}</div></div></li>
    <li><span class="n">4</span><div class="t">Click the puzzle icon in the toolbar and pin <b>Proxy App</b>. Click it to choose which IP this profile uses.</div></li>
  </ol>
  <footer>When Proxy App is off, this profile stops loading pages instead of showing your real IP. You can change that in the extension.</footer>
</main>
<script nonce="${nonce}">
  for (const b of document.querySelectorAll('button[data-copy]')) {
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
  }
</script>
</body></html>`;
}
