import { FLAGS } from './flags.js';

const $ = (id) => document.getElementById(id);
const regions = new Intl.DisplayNames(undefined, { type: 'region' });
const countryName = (cc) => {
  try {
    return cc ? regions.of(cc.toUpperCase()) : '';
  } catch {
    return cc ?? '';
  }
};

const send = (msg) =>
  chrome.runtime.sendMessage(msg).then((res) => {
    if (res?.error) throw new Error(res.error);
    return res;
  });

// All of this comes from the background script, which measures the IP once and
// remembers it. Opening the popup only reads; it never starts a lookup.
let current = null;
let busy = '';

const GLOBE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>';
const TICK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** Bundled SVG flag, or a code chip when it isn't one of the bundled countries. Only our own markup goes in. */
function flagHtml(cc) {
  const code = cc?.toUpperCase();
  if (code && FLAGS[code]) return FLAGS[code];
  return code ? `<span class="chip">${code}</span>` : '';
}

const STATES = {
  disabled: { pill: ['Not used', ''], title: 'Not using the proxy', sub: () => 'This profile uses your normal connection.' },
  appOff: {
    pill: ['Off', 'bad'],
    title: 'Proxy App is off',
    sub: (s) => (s.whenOff === 'block' ? 'Pages are blocked so your real IP stays hidden.' : 'This profile uses your normal connection until you connect.'),
  },
  appClosed: {
    pill: ['App closed', 'bad'],
    title: 'Proxy App isn’t open',
    sub: (s) => `Open Proxy App on this computer.${s.whenOff === 'block' ? ' Pages are blocked until then.' : ''}`,
  },
  missing: { pill: ['No IP', 'bad'], title: 'That IP was removed', sub: () => 'Pick another IP below.' },
};

function renderHero({ settings, exit, state, measured }) {
  const pill = $('pill');
  if (state === 'on') {
    pill.className = 'pill on';
    $('pill-text').textContent = 'Connected';
    const ip = measured?.ip ?? exit?.ip;
    const place = measured?.place || [exit?.city, countryName(exit?.countryCode)].filter(Boolean).join(', ');
    $('flag').innerHTML = flagHtml(exit?.countryCode);
    $('ip').textContent = ip ?? 'Looking up…';
    $('ip').classList.toggle('dim', !ip);
    $('copy').hidden = !ip;
    $('title').textContent = place;
    const how = settings.pin ? 'fixed for this profile' : 'follows the app';
    const rotating = exit?.mode === 'rotating' ? ' · changes on every connection' : '';
    $('sub').textContent = exit ? `${exit.name} · ${how}${rotating}` : '';
    return;
  }
  const copy = STATES[state] ?? STATES.appClosed;
  pill.className = `pill ${copy.pill[1]}`;
  $('pill-text').textContent = copy.pill[0];
  $('flag').innerHTML = '';
  $('ip').textContent = '';
  $('copy').hidden = true;
  $('title').textContent = copy.title;
  $('sub').textContent = copy.sub(settings);
}

function option({ value, flag, name, meta, mono, latency, checked, disabled }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'opt';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(checked));
  b.dataset.value = value;
  b.disabled = Boolean(disabled);
  const icon = flag ? `<span class="flag">${flag}</span>` : `<span class="globe">${GLOBE}</span>`;
  b.innerHTML = `${icon}<span class="grow"><span class="name"></span><span class="meta${mono ? ' mono' : ''}"></span></span><span class="lat"></span><span class="tick">${checked ? TICK : ''}</span>`;
  b.querySelector('.name').textContent = name;
  b.querySelector('.meta').textContent = meta;
  b.querySelector('.lat').textContent = latency ? `${latency} ms` : '';
  return b;
}

function renderExits({ settings, status }) {
  const section = $('exits-section');
  section.hidden = !status;
  if (!status) return;
  const active = status.exits.find((e) => e.id === status.activeExitId);
  const items = [
    { value: '', name: 'Follows the app', meta: active ? `Now ${active.name}` : 'No IP selected', checked: !settings.pin },
    ...status.exits.map((e) => ({
      value: e.id,
      flag: flagHtml(e.countryCode),
      name: e.name,
      meta: e.port ? [e.ip, e.city].filter(Boolean).join(' · ') || 'Not checked yet' : 'Port in use by another app',
      mono: Boolean(e.ip) && Boolean(e.port),
      latency: e.latencyMs,
      checked: settings.pin === e.id,
      disabled: !e.port,
    })),
  ];
  if (settings.pin && !status.exits.some((e) => e.id === settings.pin)) {
    items.push({ value: settings.pin, name: 'Removed IP', meta: 'Pick another', checked: true });
  }
  const sig = JSON.stringify(items);
  const list = $('exits');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.replaceChildren(...items.map(option));
}

function renderActions({ settings, exit, state }) {
  const on = state === 'on';
  const sticky = on && exit?.mode === 'sticky';
  $('connect').hidden = on || state === 'appClosed' || state === 'missing';
  $('connect').textContent = busy === 'connect' ? 'Connecting…' : 'Connect';
  $('rotate').hidden = !sticky;
  $('rotate-text').textContent = busy === 'rotate' ? 'Getting a new IP…' : 'New IP';
  $('rotate').classList.toggle('spin', busy === 'rotate');
  $('disconnect').hidden = !settings.enabled || state === 'disabled';
  $('disconnect').textContent = busy === 'disconnect' ? 'Disconnecting…' : on ? 'Disconnect' : 'Use normal connection';
  for (const id of ['connect', 'rotate', 'disconnect']) $(id).disabled = Boolean(busy);
  // A lone button spans the row.
  document.querySelector('.actions').classList.toggle('one', document.querySelectorAll('.actions .btn:not([hidden])').length === 1);
}

function renderSettings({ settings, level }) {
  for (const b of document.querySelectorAll('[data-off]')) b.setAttribute('aria-checked', String(b.dataset.off === settings.whenOff));
  $('off-hint').textContent = settings.whenOff === 'block' ? 'Pages fail to load instead of showing your real IP.' : 'This profile browses normally until Proxy App is back.';
  $('webrtc').checked = settings.webrtc;
  if (document.activeElement !== $('port')) $('port').value = settings.port;
  const warn = $('warn');
  warn.hidden = level !== 'controlled_by_other_extensions';
  warn.textContent = 'Another extension is controlling the proxy in this profile. Turn it off so Proxy App can work.';
}

function render() {
  if (!current) return;
  renderHero(current);
  renderActions(current);
  renderExits(current);
  renderSettings(current);
}

function showError(err) {
  const el = $('error');
  el.textContent = err ? (err instanceof Error ? err.message : String(err)) : '';
  el.hidden = !err;
}

async function refresh() {
  const res = await send({ type: 'sync' }).catch((e) => (showError(e), null));
  if (res) {
    current = res;
    render();
  }
}

async function act(name, msg) {
  busy = name;
  showError(null);
  render();
  try {
    const res = await send(msg);
    if (res?.state) current = res;
  } catch (err) {
    showError(err);
  } finally {
    busy = '';
    await refresh();
  }
}

$('connect').addEventListener('click', () => act('connect', { type: 'connect' }));
$('disconnect').addEventListener('click', () => act('disconnect', { type: 'disconnect' }));
$('rotate').addEventListener('click', () => current?.exit && act('rotate', { type: 'rotate', exitId: current.exit.id }));
$('copy').addEventListener('click', async () => {
  const ip = current?.measured?.ip ?? current?.exit?.ip;
  if (!ip) return;
  await navigator.clipboard.writeText(ip);
  const b = $('copy');
  const html = b.innerHTML;
  b.innerHTML = TICK;
  b.setAttribute('aria-label', 'Copied');
  setTimeout(() => {
    b.innerHTML = html;
    b.setAttribute('aria-label', 'Copy IP address');
  }, 1200);
});

const save = (patch) => chrome.storage.local.set(patch).then(refresh);
$('exits').addEventListener('click', (e) => {
  const b = e.target.closest('.opt');
  if (b && !b.disabled) save({ pin: b.dataset.value, pinPort: 0 });
});
for (const b of document.querySelectorAll('[data-off]')) b.addEventListener('click', () => save({ whenOff: b.dataset.off }));
$('webrtc').addEventListener('change', (e) => save({ webrtc: e.target.checked }));
$('port').addEventListener('change', (e) => {
  const port = Number(e.target.value);
  if (port >= 1024 && port <= 65535) save({ port });
});

// The background finished a lookup; show it.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'measured') refresh();
});

refresh();
const timer = setInterval(refresh, 3000);
addEventListener('unload', () => clearInterval(timer));
