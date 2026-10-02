import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import type { ProxyEndpoint } from '../src/shared/types';
import { Gateway, type Route } from '../src/core/gateway';
import type { UpstreamError } from '../src/core/upstream';

// A fake world: "remote" hosts are all served by one local server, reached
// only through a fake upstream proxy that checks its login.

let target: http.Server;
let echo: net.Server;
let upstream: net.Server;
let gateway: Gateway;
let targetPort = 0;
let echoPort = 0;
let upstreamPort = 0;
const gatewayPort = 18899;
const pinnedPort = 18901;
const seen: { method: string; target: string; auth: string | undefined }[] = [];
let route: Route | null = null;
const upstreamErrors: (UpstreamError | null)[] = [];
const controlled: string[] = [];

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

function endpoint(username: string): ProxyEndpoint {
  return { protocol: 'http', host: '127.0.0.1', port: upstreamPort, username, password: 'pw' };
}

before(async () => {
  target = http.createServer((req, res) => res.end(`hello from ${req.headers.host}${req.url}`));
  targetPort = await listen(target);
  echo = net.createServer((s) => s.pipe(s));
  echoPort = await listen(echo);

  upstream = net.createServer((client) => {
    client.once('data', (chunk) => {
      const head = chunk.toString('latin1');
      const [method, tgt] = head.split(' ');
      const auth = head.match(/Proxy-Authorization: Basic (\S+)/i)?.[1];
      const login = auth ? Buffer.from(auth, 'base64').toString() : undefined;
      seen.push({ method, target: tgt, auth: login });
      if (login?.endsWith(':wrong') || !login) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (method === 'CONNECT') {
        const port = tgt.endsWith(':7') ? echoPort : targetPort;
        const out = net.connect(port, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          client.pipe(out).pipe(client);
        });
        return;
      }
      const url = new URL(tgt);
      const out = net.connect(targetPort, '127.0.0.1', () => {
        out.write(head.replace(tgt, url.pathname + url.search));
        client.pipe(out).pipe(client);
      });
    });
  });
  upstreamPort = await listen(upstream);

  gateway = new Gateway({
    // The pinned port always gets "exit-pinned"; the main port gets whatever `route` is.
    route: (exitId) => (exitId ? { upstream: endpoint(`login-${exitId}`), exitId } : route),
    pac: (addr) => `PROXY ${addr}`,
    upstreamResult: (err) => upstreamErrors.push(err),
    status: () => ({ app: 'proxy-app', version: 'test', connected: true, port: gatewayPort, activeExitId: route?.exitId ?? null, exits: [] }),
    control: async (action) => {
      controlled.push(action);
      return { ok: true };
    },
  });
  await gateway.start({ port: gatewayPort, allowLan: false, lanAuth: null, pinned: [{ exitId: 'pinned', port: pinnedPort }] });
  gateway.setActive(true);
});

after(async () => {
  await gateway.stop();
  target.close();
  echo.close();
  upstream.close();
});

function connectVia(host: string, port: number, via = gatewayPort): Promise<{ sock: net.Socket; status: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(via, '127.0.0.1', () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    sock.once('data', (d) => resolve({ sock, status: Number(d.toString().split(' ')[1]) }));
    sock.once('error', reject);
  });
}

function roundTrip(sock: net.Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(text);
  });
}

test('CONNECT goes through the active exit with its login', async () => {
  route = { upstream: endpoint('exit-a'), exitId: 'a' };
  const { sock, status } = await connectVia('remote.example', 7);
  assert.equal(status, 200);
  assert.equal(await roundTrip(sock, 'ping'), 'ping');
  assert.deepEqual(seen.at(-1), { method: 'CONNECT', target: 'remote.example:7', auth: 'exit-a:pw' });
  sock.destroy();
});

test('SOCKS5 clients are tunnelled through the same exit', async () => {
  route = { upstream: endpoint('exit-b'), exitId: 'b' };
  const sock = net.connect(gatewayPort, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const read = (n: number) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const on = (d: Buffer) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        if (all.length >= n) {
          sock.off('data', on);
          resolve(all);
        }
      };
      sock.on('data', on);
    });
  sock.write(Buffer.from([5, 1, 0]));
  assert.deepEqual([...(await read(2))], [5, 0]);
  const name = Buffer.from('remote.example');
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0, 7])]));
  const reply = await read(10);
  assert.equal(reply[1], 0, 'SOCKS reply should be success');
  assert.equal(await roundTrip(sock, 'hi'), 'hi');
  assert.equal(seen.at(-1)?.auth, 'exit-b:pw');
  sock.destroy();
});

test('plain HTTP is forwarded with the upstream login, and hop-by-hop headers stripped', async () => {
  route = { upstream: endpoint('exit-c'), exitId: 'c' };
  const body = await new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gatewayPort, path: 'http://site.example/page?q=1', headers: { Host: 'site.example' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
  assert.equal(body, 'hello from site.example/page?q=1');
  assert.deepEqual(seen.at(-1), { method: 'GET', target: 'http://site.example/page?q=1', auth: 'exit-c:pw' });
});

test('a rejected upstream login becomes a 502, not a login prompt', async () => {
  route = { upstream: { ...endpoint('exit-d'), password: 'wrong' }, exitId: 'd' };
  upstreamErrors.length = 0;
  const { sock, status } = await connectVia('remote.example', 7);
  assert.equal(status, 502);
  assert.equal(upstreamErrors.at(-1)?.code, 'auth');
  sock.destroy();
});

test('local targets skip the exit entirely', async () => {
  route = { upstream: endpoint('exit-e'), exitId: 'e' };
  const before = seen.length;
  const { sock, status } = await connectVia('127.0.0.1', echoPort);
  assert.equal(status, 200);
  assert.equal(await roundTrip(sock, 'direct'), 'direct');
  assert.equal(seen.length, before, 'upstream should not see local traffic');
  sock.destroy();
});

test('no exit selected gives a clear 503', async () => {
  route = null;
  const { sock, status } = await connectVia('remote.example', 7);
  assert.equal(status, 503);
  sock.destroy();
});

test('dropAll closes open tunnels so apps reconnect through the new exit', async () => {
  route = { upstream: endpoint('exit-f'), exitId: 'f' };
  const { sock } = await connectVia('remote.example', 7);
  const closed = new Promise((r) => sock.once('close', r));
  assert.ok(gateway.dropAll() >= 1);
  await closed;
  assert.ok(gateway.totals().up > 0);
});

test('serves a PAC file for phones', async () => {
  const text = await new Promise<string>((resolve) => {
    http.get({ host: '127.0.0.1', port: gatewayPort, path: '/proxy.pac' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
  });
  assert.equal(text, `PROXY 127.0.0.1:${gatewayPort}`);
});

test('a pinned port keeps its own exit, whatever is active', async () => {
  route = { upstream: endpoint('exit-main'), exitId: 'main' };
  const { sock, status } = await connectVia('remote.example', 7, pinnedPort);
  assert.equal(status, 200);
  assert.equal(seen.at(-1)?.auth, 'login-pinned:pw');
  sock.destroy();
});

test('switching drops main-port connections but leaves pinned ones alone', async () => {
  route = { upstream: endpoint('exit-main'), exitId: 'main' };
  const main = await connectVia('remote.example', 7);
  const pinned = await connectVia('remote.example', 7, pinnedPort);
  const mainClosed = new Promise((r) => main.sock.once('close', r));
  assert.equal(gateway.drop((c) => c.pinned === null), 1);
  await mainClosed;
  assert.equal(await roundTrip(pinned.sock, 'still here'), 'still here');
  pinned.sock.destroy();
});

test('pinned ports open and close with the exit list', async () => {
  await gateway.syncPinned([]);
  await assert.rejects(connectVia('remote.example', 7, pinnedPort));
  await gateway.syncPinned([{ exitId: 'pinned', port: pinnedPort }]);
  const { sock, status } = await connectVia('remote.example', 7, pinnedPort);
  assert.equal(status, 200);
  sock.destroy();
});

test('a busy pinned port is reported, not fatal', async () => {
  const squatter = net.createServer();
  const busy = await listen(squatter);
  await gateway.syncPinned([
    { exitId: 'pinned', port: pinnedPort },
    { exitId: 'other', port: busy },
  ]);
  assert.match(gateway.pinnedErrors.other ?? '', /already in use/);
  squatter.close();
  await gateway.syncPinned([{ exitId: 'pinned', port: pinnedPort }]);
  assert.equal(gateway.pinnedErrors.other, undefined);
});

function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: gatewayPort, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

test('status for the browser extension: allowed for extensions, refused for web pages', async () => {
  const ok = await getJson('/proxy-app.json', { Origin: 'chrome-extension://abcdefghijklmnop' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).app, 'proxy-app');
  assert.equal((await getJson('/proxy-app.json')).status, 200, 'no Origin header, e.g. curl');
  assert.equal((await getJson('/proxy-app.json', { Origin: 'https://evil.example' })).status, 403);
});

function post(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gatewayPort, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('extension actions: only from extension origins', async () => {
  assert.equal(await post('/proxy-app/connect', { Origin: 'chrome-extension://abc' }), 200);
  assert.deepEqual(controlled, ['connect']);
  assert.equal(await post('/proxy-app/connect', { Origin: 'https://evil.example' }), 403);
  assert.equal(await post('/proxy-app/connect', {}), 403, 'no Origin header');
  assert.deepEqual(controlled, ['connect']);
});

test('standby: still answers the extension, but refuses traffic', async () => {
  route = { upstream: endpoint('exit-x'), exitId: 'x' };
  gateway.setActive(false);
  const { sock, status } = await connectVia('remote.example', 7);
  assert.equal(status, 503);
  sock.destroy();
  assert.equal((await getJson('/proxy-app.json')).status, 200);
  gateway.setActive(true);
});
