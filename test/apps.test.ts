import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findMain, proxyArgs, proxyPortOf, type ScannedApp } from '../src/core/apps';
import { listFirefoxProfiles, setFirefoxProxy } from '../src/core/browsers';

const slack: ScannedApp = {
  id: 'com.tinyspeck.slackmacgap',
  name: 'Slack',
  path: '/Applications/Slack.app',
  exe: '/Applications/Slack.app/Contents/MacOS/Slack',
  engine: 'electron',
  method: 'launch',
};

test('finds the main process, not Electron helpers, and reads its proxy port', () => {
  const procs = [
    { pid: 11, command: '/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer) --type=renderer' },
    { pid: 10, command: `/Applications/Slack.app/Contents/MacOS/Slack ${proxyArgs(8901).join(' ')}` },
  ];
  const main = findMain(slack, procs);
  assert.equal(main?.pid, 10);
  assert.equal(proxyPortOf(main), 8901);
  assert.equal(proxyPortOf({ pid: 1, command: '/Applications/Slack.app/Contents/MacOS/Slack' }), null);
  assert.equal(findMain(slack, [{ pid: 2, command: '/Applications/Other.app/Contents/MacOS/Other' }]), null);
});

test('Firefox: a managed user.js block switches one profile, and resets cleanly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ff-'));
  fs.mkdirSync(path.join(root, 'Profiles', 'abc.default-release'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Profiles', 'xyz.work'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'profiles.ini'),
    '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n[Profile1]\nName=work\nIsRelative=1\nPath=Profiles/xyz.work\n',
  );
  const userJs = path.join(root, 'Profiles', 'xyz.work', 'user.js');
  fs.writeFileSync(userJs, 'user_pref("browser.startup.page", 3);\n');

  assert.deepEqual(
    listFirefoxProfiles(root).map((p) => [p.name, p.extension]),
    [
      ['default-release', 'missing'],
      ['work', 'missing'],
    ],
  );

  setFirefoxProxy('Profiles/xyz.work', 8899, root);
  setFirefoxProxy('Profiles/xyz.work', 8899, root); // idempotent: one block, not two
  const on = fs.readFileSync(userJs, 'utf8');
  assert.equal(on.match(/BEGIN Proxy App/g)?.length, 1);
  assert.match(on, /"network\.proxy\.http_port", 8899/);
  assert.match(on, /browser\.startup\.page/, "the user's own prefs stay");
  assert.equal(listFirefoxProfiles(root).find((p) => p.name === 'work')?.extension, 'on');
  assert.equal(listFirefoxProfiles(root).find((p) => p.name === 'default-release')?.extension, 'missing', 'other profiles untouched');

  setFirefoxProxy('Profiles/xyz.work', null, root);
  const off = fs.readFileSync(userJs, 'utf8');
  assert.match(off, /"network\.proxy\.type", 5/);
  assert.doesNotMatch(off, /http_port/);
  assert.equal(listFirefoxProfiles(root).find((p) => p.name === 'work')?.extension, 'missing');
  fs.rmSync(root, { recursive: true, force: true });
});
