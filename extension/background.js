// Points this browser profile (and only this one) at the Proxy App gateway.
// Chrome keeps proxy settings per profile, which is what makes this work.

const DEFAULTS = {
  enabled: true,
  /** Main gateway port: follows whichever IP is selected in the app. */
  port: 8899,
  /** Exit id to always use, or '' to follow the app. */
  pin: '',
  /** Last known port of the pinned exit, so we can keep blocking while the app is closed. */
  pinPort: 0,
  /** 'block' = pages fail while the app is off (never shows the real IP); 'direct' = browse normally. */
  whenOff: 'block',
  webrtc: true,
};

const BYPASS = ['<local>', 'localhost', '127.0.0.1', '[::1]', '*.local'];
// Nothing listens here, so traffic fails instead of leaking when the pinned IP is gone.
const BLOCK_PORT = 1;
const GREEN = '#0b7d73';
const GREY = '#66717b';
const RED = '#c4322f';

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

async function fetchStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/proxy-app.json`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.app === 'proxy-app' ? data : null;
  } catch {
    return null;
  }
}

// What websites see from this profile, measured once and remembered. The popup
// only reads it, so opening the popup never triggers a lookup.
const MEASURE_TTL = 10 * 60_000;
let measuring = false;

async function getMeasured() {
  return (await chrome.storage.session.get('measured')).measured ?? null;
}

/** Same exit, same IP the app saw, same port: nothing has changed since the last measurement. */
const measureKey = (exit, port) => `${exit.id}|${exit.ip ?? ''}|${port}`;

async function lookup() {
  try {
    const r = await fetch('https://ipwho.is/?fields=success,ip,city,region,country', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    const j = await r.json();
    if (j.success === false || !j.ip) throw new Error('lookup failed');
    return { ip: j.ip, place: [j.city, j.region !== j.city ? j.region : null, j.country].filter(Boolean).join(', ') };
  } catch {
    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    return { ip: (await r.json()).ip, place: '' };
  }
}

async function measureNow(key, port, exit) {
  if (measuring) return;
  measuring = true;
  try {
    const found = await lookup();
    await chrome.storage.session.set({ measured: { key, ...found, at: Date.now() } });
    // The app's record is out of date (sticky IPs can change); have it check again.
    if (exit.ip && exit.ip !== found.ip) appAction(port, 'check', { exitId: exit.id }).catch(() => {});
  } catch {
    /* offline or blocked; the popup falls back to the app's IP */
  } finally {
    measuring = false;
    chrome.runtime.sendMessage({ type: 'measured' }).catch(() => {});
  }
}

/** Asks the app to do something (connect, new IP…). Throws with the app's message on failure. */
async function appAction(port, action, body = {}) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/proxy-app/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error("Can't reach Proxy App. Is it open on this computer?");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Proxy App said no (${res.status})`);
  return data;
}

async function setProxy(port) {
  await chrome.proxy.settings.set({
    value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port }, bypassList: BYPASS } },
    scope: 'regular',
  });
}

/** Explicitly direct, not "cleared": a cleared setting would fall back to a proxy Proxy App wrote into the profile. */
async function setDirect() {
  await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
}

async function setWebRtc(protect) {
  const policy = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!policy) return;
  if (protect) await policy.set({ value: 'disable_non_proxied_udp' });
  else await policy.clear({});
}

async function badge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}

/**
 * Works out what this profile should do right now and applies it.
 * States: on · disabled (off in this profile) · appOff (app open, not connected) · appClosed · missing (pinned IP removed).
 */
async function sync() {
  const s = await getSettings();
  const status = await fetchStatus(s.port);
  const pinned = status && s.pin ? (status.exits.find((e) => e.id === s.pin) ?? null) : null;
  const exit = status ? (s.pin ? pinned : (status.exits.find((e) => e.id === status.activeExitId) ?? null)) : null;
  const appOn = Boolean(status?.connected);

  let state;
  if (!s.enabled) {
    await setDirect();
    await setWebRtc(false);
    await badge('', GREY, 'Proxy App: not used in this profile');
    state = 'disabled';
  } else if (!appOn && s.whenOff === 'direct') {
    await setDirect();
    await setWebRtc(false);
    await badge('OFF', GREY, 'Proxy App is off. This profile uses your normal connection.');
    state = status ? 'appOff' : 'appClosed';
  } else {
    let port = s.port;
    if (s.pin) {
      if (pinned?.port) {
        port = pinned.port;
        if (s.pinPort !== pinned.port) await chrome.storage.local.set({ pinPort: pinned.port });
      } else {
        // App closed: keep the old pinned port (nothing listens, so it blocks). Pinned IP removed: block.
        port = status ? BLOCK_PORT : s.pinPort || s.port;
      }
    }
    await setProxy(port);
    await setWebRtc(s.webrtc);
    if (!status) {
      await badge('!', RED, 'Proxy App is not open. Pages are blocked so your real IP stays hidden.');
      state = 'appClosed';
    } else if (!appOn) {
      await badge('!', RED, 'Proxy App is off. Pages are blocked so your real IP stays hidden.');
      state = 'appOff';
    } else if (s.pin && !pinned?.port) {
      await badge('!', RED, 'The IP chosen for this profile is no longer in Proxy App.');
      state = 'missing';
    } else {
      await badge(exit?.countryCode ?? 'ON', GREEN, `Proxy App: ${exit?.name ?? 'connected'}`);
      state = 'on';
    }
  }

  const level = (await chrome.proxy.settings.get({})).levelOfControl;

  let measured = null;
  if (state === 'on' && exit) {
    const key = measureKey(exit, s.port);
    const cached = await getMeasured();
    if (cached?.key === key) measured = cached;
    if (!cached || cached.key !== key || Date.now() - cached.at > MEASURE_TTL) void measureNow(key, s.port, exit);
  }
  return { settings: s, status, exit, state, level, measured, measuring };
}

let running = null;
function syncOnce() {
  // Coalesce bursts (alarm + storage change + popup) into one run.
  running ??= sync().finally(() => (running = null));
  return running;
}

/** A sync that starts after everything before it, for replies right after a change. */
async function syncFresh() {
  await running?.catch(() => {});
  return syncOnce();
}

async function handle(msg) {
  const s = await getSettings();
  switch (msg?.type) {
    case 'sync':
      return syncOnce();
    case 'connect': {
      // On for this profile, and connect the app if it's off.
      await chrome.storage.local.set({ enabled: true });
      const status = await fetchStatus(s.port);
      if (status && !status.connected) await appAction(s.port, 'connect');
      return syncFresh();
    }
    case 'disconnect':
      // Only this profile goes back to the normal connection; the app keeps running for others.
      await chrome.storage.local.set({ enabled: false });
      return syncFresh();
    case 'rotate': {
      await chrome.storage.session.remove('measured');
      const check = await appAction(s.port, 'rotate', { exitId: msg.exitId });
      return { check, ...(await syncFresh()) };
    }
    case 'check':
      return appAction(s.port, 'check', { exitId: msg.exitId });
    default:
      return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('poll', { periodInMinutes: 0.5 });
  void syncOnce();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('poll', { periodInMinutes: 0.5 });
  void syncOnce();
});
chrome.alarms.onAlarm.addListener(() => void syncOnce());
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void syncOnce();
});
// A failing proxy usually means the app just stopped; refresh the badge straight away.
chrome.proxy.onProxyError.addListener(() => void syncOnce());

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg).then(reply, (err) => reply({ error: err instanceof Error ? err.message : String(err) }));
  return true;
});
