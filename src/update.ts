// Updates without an app store, on every platform.
//
// Every push to main publishes a new version. Then:
//   - the website, and the app installed from it (home screen on a phone, installed app on a
//     laptop), get it through the service worker (src/sw.ts);
//   - the iPhone app downloads the same version's files and switches to them (src/native-update.ts).
// Either way:
//   - it checks when the app opens, when it comes back to the front, every 30 minutes, and when
//     the Player taps "Check for updates" in Settings;
//   - the new version downloads in the background while the current one keeps running;
//   - it switches over at a safe moment: straight away if the app was only just opened, or when
//     the Player leaves the app. Never in the middle of a workout, while they're typing or while
//     an AI answer is on its way. Until then an "Update ready" chip (and "Update now" in Settings)
//     lets them restart when they like;
//   - after the switch, "What's new" shows what changed.

import { registerSW } from 'virtual:pwa-register';
import { CHANGES } from './changelog';
import * as Native from './native-update';

export const VERSION = __APP_VERSION__;
export const COMMIT = __APP_COMMIT__;
export const BUILT = __APP_BUILT__;

const CHECK_EVERY = 30 * 60 * 1000;
const FRESH_FOR = 15 * 1000; // an app opened this recently can reload without anyone noticing
const SEEN_KEY = 'arise-version-seen';

export type Busy = 'workout' | 'ai' | 'editing' | 'intro';
export interface UpdateHooks {
  busy: () => Busy[]; // what a restart would interrupt right now (none: an empty list)
  whatsNew: (html: string) => void; // shows the notes in the pop-up sheet
  changed?: () => void; // the update status changed (for the Settings screen)
}

const LOSES: Record<Busy, string> = {
  workout: 'Your workout in progress is saved and will still be there.',
  ai: 'The answer the System is still writing will be lost.',
  editing: "The goal you're editing hasn't been saved yet.",
  intro: 'The intro starts again from the beginning.',
};

// What Settings shows.
type Status = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'install' | 'error' | 'unsupported';
export const updateStatus = { status: 'idle' as Status, version: '', error: '', checkedAt: 0 };
function setStatus(status: Status, extra: Partial<typeof updateStatus> = {}) {
  Object.assign(updateStatus, { status, error: '' }, extra);
  if (status === 'current' || status === 'ready' || status === 'install') updateStatus.checkedAt = Date.now();
  hooks.changed?.();
}

let hooks: UpdateHooks = { busy: () => [], whatsNew: () => {} };
let applyUpdate: (() => void) | null = null; // switches to the version that's ready
let checkUpdate: (() => Promise<void>) | null = null;
let ready = false; // a new version is downloaded and waiting
let applying = false; // this page asked it to take over
let switched = false; // it has taken over, so this page is running old code
const startedAt = Date.now();

const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio'].includes((el as HTMLInputElement).type)));
};
const safeNow = () => !hooks.busy().length && !typing();

// The app does every reload itself (the plugin's own would ignore a workout in progress).
function apply() {
  chip(false);
  if (switched) return location.reload();
  if (!applyUpdate) return;
  applying = true;
  applyUpdate();
}

function onReady() {
  if (ready) return;
  ready = true;
  setStatus('ready');
  if (safeNow() && (Date.now() - startedAt < FRESH_FOR || document.visibilityState === 'hidden')) apply();
  else chip(true);
}

// The new version took over: asked for by this page, or by another tab or window of the app.
function onSwitched() {
  if (!ready && !applying) return; // a first install taking charge; this page is already current
  switched = true;
  if (applying || safeNow()) location.reload();
  else chip(true);
}

// "Update ready · Restart", and "Update now" in Settings.
export function applyNow() {
  const busy = hooks.busy();
  if (busy.length && !confirm(`Restart now? ${busy.map((b) => LOSES[b]).join(' ')}`)) return;
  apply();
}

function chip(show: boolean) {
  let el = document.getElementById('updateChip');
  if (!show) {
    el?.remove();
    return;
  }
  if (el) return;
  const btn = document.createElement('button');
  btn.id = 'updateChip';
  btn.className = 'update-chip';
  btn.type = 'button';
  btn.innerHTML = '<span class="pulse"></span><span>Update ready · <b>Restart</b></span>';
  btn.addEventListener('click', applyNow);
  document.body.append(btn);
}

// "Check for updates" in Settings.
export async function checkNow() {
  if (ready) return setStatus('ready');
  if (!checkUpdate) return setStatus('unsupported');
  await checkUpdate();
}

export function initUpdates(h: UpdateHooks) {
  hooks = h;
  showWhatsNew();
  if (Native.supported()) return initNative();
  if (Native.isNative() || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.addEventListener('controllerchange', onSwitched);
  // The new service worker asks which pages already run this version (see sw.ts).
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'ARISE_WHO') (e.source as ServiceWorker | null)?.postMessage({ type: 'ARISE_2' });
  });
  const activate = registerSW({
    immediate: true,
    onNeedRefresh: onReady,
    onNeedReload: onSwitched,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      // Follows each new version as it downloads. (The plugin's Workbox only reports new versions
      // found in the first minute, so the app keeps track of later ones itself.)
      const watched = new WeakSet<ServiceWorker>();
      const watch = (sw: ServiceWorker | null) => {
        // (Not on a first install: that's the version already running.)
        if (!sw || watched.has(sw) || !navigator.serviceWorker.controller) return;
        watched.add(sw);
        if (!ready) setStatus('downloading');
        sw.addEventListener('statechange', () => {
          if (ready) return;
          if (sw.state === 'installed') setTimeout(() => reg.waiting === sw && onReady(), 250);
          else if (updateStatus.status !== 'downloading' || reg.installing) return;
          // It stopped halfway (offline, say), or took over by itself (see sw.ts): nothing waits.
          else if (sw.state === 'redundant') setStatus('error', { error: "The update didn't finish downloading. It will try again later." });
          else if (sw.state === 'activated') setStatus('idle');
        });
      };
      reg.addEventListener('updatefound', () => watch(reg.installing));
      checkUpdate = async () => {
        setStatus('checking');
        try {
          await reg.update();
        } catch {
          return setStatus('error', { error: "Couldn't check for updates. Are you online?" });
        }
        watch(reg.installing);
        if (ready) setStatus('ready');
        else if (reg.waiting) onReady();
        else if (reg.installing) setStatus('downloading');
        else setStatus('current');
      };
      const check = () => {
        if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
      };
      setInterval(check, CHECK_EVERY);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
        // Leaving the app is the least noticeable moment to switch versions.
        else if (ready && safeNow()) apply();
      });
    },
  });
  applyUpdate = () => void activate(true);
}

// The iPhone app (see native-update.ts).
async function initNative() {
  let latest: Native.Latest | null = null;
  await Native.confirmStarted(COMMIT).catch(() => {});
  let busy = false;
  checkUpdate = async () => {
    if (busy || ready) return;
    busy = true;
    setStatus('checking');
    try {
      const found = await Native.check();
      if (found.needsInstall) setStatus('install');
      else if (!found.latest) setStatus('current');
      else {
        setStatus('downloading', { version: found.latest.version });
        await Native.download(found.latest);
        latest = found.latest;
        updateStatus.version = latest.version;
        onReady();
      }
    } catch (err) {
      setStatus('error', { error: (err as Error)?.message || "Couldn't check for updates." });
    }
    busy = false;
  };
  applyUpdate = () => {
    if (latest) Native.apply(latest).catch((err) => setStatus('error', { error: (err as Error)?.message || "Couldn't switch to the new version." }));
  };
  const check = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void checkUpdate?.();
  };
  setInterval(check, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
    else if (ready && safeNow()) apply();
  });
  check();
}

// ---------- the Settings section

export function updatesPanel(esc: (s: string) => string) {
  const u = updateStatus;
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const line =
    u.status === 'checking'
      ? 'Checking for updates…'
      : u.status === 'downloading'
        ? `Downloading ${u.version ? `version ${esc(u.version)}` : 'the new version'}…`
        : u.status === 'ready'
          ? 'A new version is ready. Tap <b>Update now</b>, or it switches over by itself next time you open or leave the app.'
          : u.status === 'current'
            ? `You have the latest version (checked ${time(u.checkedAt)}).`
            : u.status === 'install'
              ? 'A new version needs a newer iPhone app. Install the latest Arise.ipa the same way as before, and your data stays. (A new Arise.ipa can take up to half an hour to appear after an update.)'
              : u.status === 'error'
                ? esc(u.error)
                : u.status === 'unsupported'
                  ? Native.isNative()
                    ? "This copy of the iPhone app was built on a computer, so it doesn't update itself."
                    : "This browser can't update the app by itself. Reload the page to get the latest version."
                  : '';
  return `<section class="panel" id="updatesPanel">
    <div class="panel-title"><span>App updates</span></div>
    <p>Version ${esc(VERSION)} (${esc(COMMIT)}). Arise updates itself: new versions download in the background and switch over when you open or leave the app, never in the middle of a workout.</p>
    ${line ? `<p class="small${u.status === 'error' ? ' error' : ' muted'}" role="status">${line}</p>` : ''}
    <div class="row">
      ${ready ? '<button class="btn primary small" data-act="update-apply">Update now</button>' : `<button class="btn ghost small" data-act="update-check" ${u.status === 'checking' || u.status === 'downloading' ? 'disabled' : ''}>Check for updates</button>`}
    </div>
  </section>`;
}

// ---------- what's new

function showWhatsNew() {
  let seen: string | null = null;
  try {
    // Data from before versions were tracked means this device ran 1.0.0.
    seen = localStorage.getItem(SEEN_KEY) || (localStorage.getItem('pit-data-v1') ? '1.0.0' : null);
    localStorage.setItem(SEEN_KEY, VERSION);
  } catch {}
  // A first install has nothing to compare with; it just remembers the version.
  if (!seen || seen === VERSION) return;
  const fresh = CHANGES.filter((c) => newer(c.version, seen));
  if (!fresh.length) return;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  hooks.whatsNew(`<p class="kicker">Updated to ${esc(VERSION)}</p>
    <h2 class="display sheet-title">What's new</h2>
    ${fresh.map((c) => `<h3 class="sub">${esc(c.version)}</h3><ul class="changes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`).join('')}
    <button class="btn primary block" data-act="sheet-close">Got it</button>`);
}

// True when version a is later than b (both like 2.1.0).
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
