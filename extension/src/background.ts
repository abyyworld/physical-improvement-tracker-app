// The extension's background: it listens to the browser and hands everything to the recorder
// (lib/recorder.ts), which does the work. In Chrome it's a service worker that sleeps between
// events; in Firefox an event page. Either way, what it must remember is in storage, not here.
//
// It never runs in private (incognito) windows: the manifest says "not_allowed", and any private
// tab or window that still shows up is ignored.

import { api, ARISE } from './api';
import { browserName } from './lib/events';
import { NS, type Push, parseRequest } from './lib/pairing';
import * as R from './lib/recorder';
import { matchesPrefix } from './lib/url';

const IDLE_SECONDS = 120; // no keys or mouse for 2 minutes: away (unless the tab plays sound)
const TICK = 'tick';

const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string }[]; platform: string }; brave?: unknown };
const BROWSER = browserName(navigator.userAgent, nav.userAgentData?.brands, nav.userAgentData?.platform, !!nav.brave);

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const area = (a: typeof api.storage.local): R.KV => ({
  get: (keys) => a.get(keys),
  set: (items) => a.set(items),
  remove: (keys) => (keys.length ? a.remove(keys) : Promise.resolve()),
});

const env: R.Env = {
  now: () => Date.now(),
  local: area(api.storage.local),
  session: area(api.storage.session),
  history: {
    search: (q) => api.history.search(q),
    getVisits: (d) => api.history.getVisits(d),
  },
  browser: BROWSER,
  version: api.runtime.getManifest().version,
  arise: ARISE,
  allowed: (origin) => ARISE.some((p) => originOf(p) === origin || matchesPrefix(origin + '/', [p])),
  push,
  openConfirm,
};

// Tells Arise's open tabs (their content script passes it to the page).
async function push(p: Push, origin: string) {
  const tabs = await api.tabs.query({});
  for (const t of tabs) {
    if (t.id == null || !t.url || t.incognito || originOf(t.url) !== origin || !matchesPrefix(t.url, ARISE)) continue;
    api.tabs.sendMessage(t.id, { ns: NS, push: p }).catch(() => {});
  }
}

// The small window with the 4 words to compare.
let confirmWindow: number | undefined;
async function openConfirm() {
  if (confirmWindow != null) {
    try {
      await api.windows.update(confirmWindow, { focused: true });
      return;
    } catch {}
  }
  const w = await api.windows.create({ url: api.runtime.getURL('popup.html?pair=1'), type: 'popup', width: 400, height: 600, focused: true });
  confirmWindow = w.id;
}

// The page in front, if it counts as time on a site right now.
async function currentUrl(): Promise<string | null> {
  try {
    const state = await api.idle.queryState(IDLE_SECONDS);
    if (state === 'locked') return null;
    const win = await api.windows.getLastFocused({ populate: true });
    if (!win?.focused || win.incognito || win.type === 'devtools') return null;
    const tab = win.tabs?.find((t) => t.active);
    if (!tab?.url || tab.incognito) return null;
    if (state === 'idle' && !tab.audible) return null;
    return tab.url;
  } catch {
    return null;
  }
}

const look = async () => R.observe(env, await currentUrl()).catch(() => {});
const tick = async (opts: { deep?: boolean } = {}) => R.tick(env, await currentUrl(), opts).catch(() => {});

// A visit: read the history a few seconds later (its title is in by then), not a minute later.
let soon: ReturnType<typeof setTimeout> | undefined;
function tickSoon(ms = 4000) {
  clearTimeout(soon);
  soon = setTimeout(() => void tick(), ms);
}

async function badge() {
  const s = await R.getSettings(env);
  await api.action.setBadgeBackgroundColor({ color: '#5a6472' }).catch(() => {});
  await api.action.setBadgeText({ text: s.paused ? 'off' : '' }).catch(() => {});
}

async function start() {
  if (!(await api.alarms.get(TICK))) await api.alarms.create(TICK, { periodInMinutes: 1 });
  api.idle.setDetectionInterval(IDLE_SECONDS);
  await badge();
}

// ---------- listeners (all at the top, so a sleeping service worker wakes for them)

api.runtime.onInstalled.addListener(() => void start());
api.runtime.onStartup.addListener(() => void start());
api.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK) void tick();
});
api.history.onVisited.addListener(() => tickSoon());
api.tabs.onActivated.addListener(() => void look());
api.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.status === 'complete' || change.audible !== undefined)) void look();
});
api.windows.onFocusChanged.addListener(() => void look());
api.idle.onStateChanged.addListener(() => void look());
// The last window closed: the hour so far is sealed before memory goes.
api.windows.onRemoved.addListener(async () => {
  const left = await api.windows.getAll({ windowTypes: ['normal'] }).catch(() => [{}]);
  if (!left.length) await R.flush(env).catch(() => {});
});

api.runtime.onMessage.addListener((msg, sender, respond) => {
  const m = msg as { ns?: string; msg?: unknown };
  if (sender.id !== api.runtime.id || !m || typeof m !== 'object') return;

  // From Arise's page, through the content script: only from Arise's own pages.
  if (m.ns === NS) {
    const url = sender.tab?.url || sender.url || '';
    const req = parseRequest(m.msg);
    if (!req || !sender.tab || sender.tab.incognito || !matchesPrefix(url, ARISE)) {
      respond({ ok: false, error: 'not-arise' });
      return;
    }
    R.pageRequest(env, req, originOf(url)).then(respond, () => respond({ ok: false, error: 'failed' }));
    return true;
  }

  // From the extension's own menu or its window with the 4 words.
  if (m.ns === R.POPUP_NS && (sender.url || '').startsWith(api.runtime.getURL(''))) {
    const req = m.msg as R.PopupRequest;
    R.popupRequest(env, req).then(
      async (r) => {
        respond(r);
        if (req.t === 'confirm' || req.t === 'resume' || req.t === 'forget') tickSoon(200);
        await badge();
      },
      () => respond({ ok: false, error: 'failed' }),
    );
    return true;
  }
});

void start();
