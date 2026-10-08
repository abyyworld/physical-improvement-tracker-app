// Updates without an app store.
//
// Every push to main publishes a new version of the website. Installed copies (home screen on a
// phone, installed app on a laptop) pick it up by themselves:
//   - they check when the app opens, when it comes back to the front, and every 30 minutes;
//   - the new version downloads in the background while the current one keeps running;
//   - it switches over at a safe moment: straight away if the app was only just opened, or when
//     the Player leaves the app. Never in the middle of a workout or while they're typing.
//     If neither comes soon, a small "Update ready" chip lets them restart when they like;
//   - after the switch, "What's new" shows what changed.

import { registerSW } from 'virtual:pwa-register';
import { CHANGES } from './changelog';

export const VERSION = __APP_VERSION__;
export const COMMIT = __APP_COMMIT__;

const CHECK_EVERY = 30 * 60 * 1000;
const FRESH_FOR = 15 * 1000; // an app opened this recently can reload without anyone noticing
const SEEN_KEY = 'arise-version-seen';

export interface UpdateHooks {
  busy: () => boolean; // a workout or something unsaved is in progress
  whatsNew: (html: string) => void; // shows the notes in the pop-up sheet
}

let hooks: UpdateHooks = { busy: () => false, whatsNew: () => {} };
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;
let ready = false; // a new version is downloaded and waiting
let applying = false; // this page asked it to take over
let switched = false; // it has taken over, so this page is running old code
const startedAt = Date.now();

const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio'].includes((el as HTMLInputElement).type)));
};
const safeNow = () => !hooks.busy() && !typing();

// The app does every reload itself (the plugin's own would ignore a workout in progress).
function apply() {
  chip(false);
  if (switched) return location.reload();
  if (!applyUpdate) return;
  applying = true;
  void applyUpdate(true);
}

function onReady() {
  ready = true;
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
  btn.addEventListener('click', () => {
    if (hooks.busy() && !confirm('Restart now? Your workout in progress is saved and will still be there.')) return;
    apply();
  });
  document.body.append(btn);
}

export function initUpdates(h: UpdateHooks) {
  hooks = h;
  showWhatsNew();
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.addEventListener('controllerchange', onSwitched);
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh: onReady,
    onNeedReload: onSwitched,
    onRegisteredSW(_url, reg) {
      if (!reg) return;
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
