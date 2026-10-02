import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listProcesses, scanApps } from '../src/core/apps';
import { DEFAULT_BYPASS } from '../src/core/store';
import { run } from '../src/core/sysproxy/run';
import { windowsProxy } from '../src/core/sysproxy/win32';

// Runs on the Windows CI machine; skipped everywhere else.
const onWindows = { skip: process.platform !== 'win32' };
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

async function read(name: string): Promise<string | null> {
  try {
    const out = await run('reg', ['query', KEY, '/v', name]);
    return out.match(new RegExp(`${name}\\s+REG_\\w+\\s*(.*)`))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

test('Windows system proxy: apply, then restore exactly', onWindows, async () => {
  const before = { enable: await read('ProxyEnable'), server: await read('ProxyServer'), override: await read('ProxyOverride') };
  const snap = await windowsProxy.apply('127.0.0.1', 18899, DEFAULT_BYPASS);
  assert.equal(await read('ProxyServer'), '127.0.0.1:18899');
  assert.equal(await read('ProxyEnable'), '0x1');
  assert.match((await read('ProxyOverride')) ?? '', /<local>/);
  await windowsProxy.restore(snap);
  assert.deepEqual({ enable: await read('ProxyEnable'), server: await read('ProxyServer'), override: await read('ProxyOverride') }, before.enable === null ? { ...before, enable: '0x0' } : before);
});

test('Windows: installed apps and processes can be read', onWindows, async () => {
  const apps = await scanApps(true);
  assert.ok(Array.isArray(apps));
  console.log(`found ${apps.length} apps:`, apps.slice(0, 15).map((a) => `${a.name} [${a.engine}/${a.method}]`).join(', '));
  const procs = await listProcesses();
  assert.ok(procs.length > 0, 'process list should not be empty');
});
