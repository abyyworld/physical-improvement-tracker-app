// The app lock's screens: the lock itself, and its part of Settings. The lock covers everything
// while the app keeps running under it (a quest in progress, its timers, reminders). The passcode
// and Face ID checks, and the rules for them, are in lib/lock.ts.

import * as L from './lib/lock';
import { esc, icon, openSheet, closeSheet, toast, BACKGROUND, backgroundInert } from './ui.js';
import * as N from './native.js';

const $ = (sel, root = document) => root.querySelector(sel);

let hooks = { forgot: async () => false, signedIn: () => false, checking: () => false, render: () => {} };
let root = null;
let shown = false;
let entry = '';
let checking = false;
let note = { text: '', error: false };
let hiddenAt = 0;
let bioOk = false; // Face ID / Touch ID can be used on this device (not in the iPhone app)
let bioBusy = false; // its own prompt is up, which may hide the page for a moment
let waitTimer = null;
let before = null; // what had focus before it locked
const held = new Map(); // what it made inert, and whether it was inert already
let watcher = null;

// An app that restarts itself (an update) while unlocked and in use doesn't ask again.
const SEEN = 'arise-lock-seen';
const RELOAD_GRACE = 10_000;

export const isLocked = () => shown;
export const turnOff = () => L.turnOff();
// Face ID needs a browser: the iPhone app (capacitor://localhost) can't use it.
const canBio = () => bioOk && !N.isNative;

export function initLock(h) {
  hooks = { ...hooks, ...h };
  if (!N.isNative) {
    L.bioAvailable().then((ok) => {
      bioOk = ok;
      if (ok) {
        if (shown) draw();
        hooks.render();
      }
    });
  }
  let seen = 0;
  try {
    seen = Number(sessionStorage.getItem(SEEN)) || 0;
    sessionStorage.removeItem(SEEN);
  } catch {}
  const now = Date.now();
  if (L.isOn() && !(seen && seen <= now && now - seen < RELOAD_GRACE)) lock();
}

// ---------- when it locks

document.addEventListener('visibilitychange', () => {
  const l = L.read();
  if (!l || bioBusy) return;
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    if (l.away === 0) lock(); // covered before the phone takes its picture for the app switcher
  } else if (hiddenAt && L.awayTooLong(hiddenAt, Date.now(), l.away)) lock();
});

window.addEventListener('pagehide', () => {
  try {
    if (!shown && L.isOn() && document.visibilityState === 'visible') sessionStorage.setItem(SEEN, String(Date.now()));
  } catch {}
});

// Turned off in another tab or window: this one opens too.
window.addEventListener('storage', (e) => {
  if (e.key === L.KEY && !e.newValue && shown) unlock();
});

// ---------- the lock screen

export function lock() {
  if (shown || !L.isOn()) return;
  shown = true;
  entry = '';
  note = { text: '', error: false };
  before = document.activeElement;
  if (!root) {
    root = document.createElement('div');
    root.id = 'lock';
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Arise is locked');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) press(b.dataset.k);
    });
  }
  document.body.append(root);
  root.hidden = false;
  document.body.classList.add('locked');
  cover();
  draw();
  root.focus({ preventScroll: true });
}

function unlock() {
  shown = false;
  clearInterval(waitTimer);
  waitTimer = null;
  root.hidden = true;
  root.innerHTML = '';
  document.body.classList.remove('locked');
  uncover();
  if (before?.isConnected && before !== document.body) before.focus({ preventScroll: true });
  before = null;
}

// Everything else is inert while it's locked: no taps, no Tab, nothing for screen readers.
function cover() {
  const hold = (el) => {
    if (el === root || held.has(el)) return;
    held.set(el, el.hasAttribute('inert'));
    el.setAttribute('inert', '');
  };
  for (const el of document.body.children) hold(el);
  // Anything added meanwhile (a pop-up, the intro) too.
  watcher = new MutationObserver(() => {
    for (const el of document.body.children) hold(el);
  });
  watcher.observe(document.body, { childList: true });
}
function uncover() {
  watcher?.disconnect();
  watcher = null;
  // A pop-up or the intro that opened or closed meanwhile decides for what's behind it.
  for (const [el, was] of held) el.toggleAttribute('inert', BACKGROUND.some((s) => el.matches(s)) ? backgroundInert() : was);
  held.clear();
}

// Focus stays on the lock.
document.addEventListener('focusin', (e) => {
  if (shown && !root.contains(e.target)) root.focus({ preventScroll: true });
});

// Keys go to the lock only (the app's own, like Escape closing a pop-up, wait until it's open).
window.addEventListener(
  'keydown',
  (e) => {
    if (!shown) return;
    e.stopPropagation();
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      press(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      press('del');
    } else if (e.key === 'Enter' && e.target === root) {
      e.preventDefault();
      press('ok');
    } else if (e.key === 'Escape') e.preventDefault();
  },
  true,
);

const digits = () => L.read()?.digits || 0;

function draw() {
  if (!root || !shown) return;
  const l = L.read();
  const bio = canBio() && L.bioUsable(l);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => `<button class="lock-key" data-k="${n}">${n}</button>`).join('');
  // Without a known length (it always has one, unless the saved lock was changed by hand) an OK key.
  const ok = digits() ? '<span></span>' : '<button class="lock-key plain" data-k="ok">OK</button>';
  root.innerHTML = `<div class="lock-in">
    <span class="lock-mark">Arise</span>
    <p class="kicker">${icon('lock')} Locked</p>
    <p class="lock-msg" role="status" aria-live="polite"></p>
    <div class="lock-dots" aria-hidden="true"></div>
    <div class="lock-pad">${keys}${ok}<button class="lock-key" data-k="0">0</button><button class="lock-key plain" data-k="del" aria-label="Delete">${icon('del')}</button></div>
    ${bio ? `<button class="btn primary block" data-k="bio">${icon('face')} Unlock with ${esc(L.bioName())}</button>` : ''}
    <button class="link" data-k="forgot">Forgot your passcode?</button>
  </div>`;
  paint();
}

// The parts that change as keys are pressed (the buttons stay, so focus does too).
function paint() {
  if (!root || !shown) return;
  const wait = L.waitLeft();
  const msg = $('.lock-msg', root);
  if (wait) {
    msg.textContent = `Too many wrong tries. Try again in ${waitText(wait)}.`;
    msg.classList.add('error');
    if (!waitTimer) waitTimer = setInterval(paint, 1000);
  } else {
    if (waitTimer) {
      clearInterval(waitTimer);
      waitTimer = null;
      note = { text: '', error: false };
    }
    msg.textContent = note.text || 'Enter your passcode';
    msg.classList.toggle('error', note.error);
  }
  const n = digits() || Math.max(4, entry.length);
  $('.lock-dots', root).innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < entry.length ? 'on' : ''}"></i>`).join('');
  for (const b of root.querySelectorAll('.lock-pad button')) b.setAttribute('aria-disabled', String(!!wait || checking));
}

const waitText = (ms) => {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} ${s === 1 ? 'second' : 'seconds'}` : `${Math.ceil(s / 60)} minutes`;
};

async function press(k) {
  if (k === 'bio') return bioUnlock();
  if (k === 'forgot') return forgot();
  if (checking || L.waitLeft()) return;
  if (k === 'del') entry = entry.slice(0, -1);
  else if (/^\d$/.test(k) && entry.length < 8) entry += k;
  else if (k !== 'ok') return;
  note = { text: '', error: false };
  paint();
  if (digits() ? entry.length === digits() : k === 'ok' && entry.length >= 4) await submit();
}

async function submit() {
  checking = true;
  paint();
  const r = await L.check(entry);
  checking = false;
  entry = '';
  if (r === 'ok') return unlock();
  note = { text: 'Wrong passcode. Try again.', error: true };
  paint();
  const dots = $('.lock-dots', root);
  dots?.classList.remove('shake');
  void dots?.offsetWidth;
  dots?.classList.add('shake');
}

async function bioUnlock() {
  const l = L.read();
  if (!l || !L.bioUsable(l) || bioBusy) return;
  bioBusy = true;
  const ok = await L.bioVerify(l.bio);
  bioBusy = false;
  if (ok) {
    L.update({ fails: 0, until: 0 });
    return unlock();
  }
  note = { text: `${capital(L.bioName())} didn't unlock it. Use your passcode.`, error: true };
  paint();
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Forgot the passcode: the only way in is a fresh start on this device. Signed in, the data is
// in the account; not signed in, it's lost (and a backup can't be saved while it's locked).
async function forgot() {
  if (hooks.checking()) {
    note = { text: 'Checking your account. Try again in a moment.', error: false };
    return paint();
  }
  const signedIn = hooks.signedIn();
  const msg = signedIn
    ? "Sign out and erase Arise's data on this device? Your data stays in your account, end-to-end encrypted. Sign in again to get it back. The app lock will be off."
    : "You're not signed in, so your data is only on this device. Erasing it can't be undone: your goals, quests and history will be gone for good. A backup can't be saved while Arise is locked. Erase everything on this device?";
  if (!confirm(msg)) return;
  if (!signedIn && !confirm('Are you sure? Everything in Arise on this device will be lost.')) return;
  if (!(await hooks.forgot(signedIn))) return; // kept changes that haven't reached the cloud
  L.turnOff();
  unlock();
}

// ---------- Settings

export function settingsPanel() {
  const l = L.read();
  const name = L.bioName();
  const bio = canBio() ? ` or ${esc(name)}` : '';
  return `<section class="panel" id="lockPanel">
    <div class="panel-title">${icon('lock')}<span>App lock</span></div>
    <p>Ask for a passcode${bio} when Arise opens, and when it comes back after time away. For this device only.</p>
    <button class="toggle-row" data-act="lock-toggle" aria-pressed="${!!l}"><span><b>App lock</b></span><span class="switch ${l ? 'on' : ''}"></span></button>
    ${
      l
        ? `<p class="label">Ask again after</p>
    <div class="seg" role="group">${L.AWAY.map((m) => `<button class="${l.away === m ? 'on' : ''}" data-act="lock-away" data-v="${m}" aria-pressed="${l.away === m}">${m ? `${m} min` : 'Right away'}</button>`).join('')}</div>
    ${canBio() ? `<button class="toggle-row" data-act="lock-bio" aria-pressed="${L.bioUsable(l)}"><span><b>Unlock with ${esc(name)}</b></span><span class="switch ${L.bioUsable(l) ? 'on' : ''}"></span></button>` : ''}
    <p class="muted small">To change the passcode, turn the lock off and on again.</p>`
        : ''
    }
    ${N.isNative ? `<p class="muted small">Face ID can't be used for the lock in the iPhone app yet, so it uses a passcode. In the web app, Face ID or Touch ID can unlock it too.</p>` : ''}
    <p class="muted small">The lock keeps people out of the app. It doesn't encrypt what's saved on this device.</p>
  </section>`;
}

const pinInput = (id, label) =>
  `<label class="field"><span class="k">${label}</span><input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off"></label>`;

function showError(text) {
  const el = $('#lockErr');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// Returns true when it handled the action.
export async function handleAction(act, el) {
  switch (act) {
    case 'lock-toggle':
      if (!L.isOn()) {
        openSheet(`<p class="kicker">App lock</p><h2 class="display sheet-title">Choose a passcode</h2>
          <p>4 to 8 digits. Arise asks for it when it opens on this device.</p>
          ${pinInput('lockNew', 'Passcode')}
          ${pinInput('lockNew2', 'Same passcode again')}
          ${canBio() ? `<label class="check"><input type="checkbox" id="lockBio" checked> Also unlock with ${esc(L.bioName())}</label>` : ''}
          <p class="error small" id="lockErr" role="alert" hidden></p>
          <button class="btn primary block" data-act="lock-on">Turn on app lock</button>
          <p class="muted small">If you forget it, you can erase Arise on this device and sign in again to get your data back. Without an account, the data on this device would be lost.</p>`);
      } else {
        const l = L.read();
        openSheet(`<p class="kicker">App lock</p><h2 class="display sheet-title">Turn off the lock</h2>
          <p>Enter your passcode to turn it off.</p>
          ${pinInput('lockOld', 'Passcode')}
          <p class="error small" id="lockErr" role="alert" hidden></p>
          <button class="btn primary block" data-act="lock-off">Turn off app lock</button>
          ${canBio() && L.bioUsable(l) ? `<button class="btn ghost block" data-act="lock-off-bio">${icon('face')} Use ${esc(L.bioName())}</button>` : ''}`);
      }
      $('#lockNew, #lockOld')?.focus();
      return true;
    case 'lock-on': {
      const p = $('#lockNew')?.value || '';
      if (!L.validPasscode(p)) return showError('The passcode needs 4 to 8 digits.'), true;
      if (p !== $('#lockNew2')?.value) return showError("The two passcodes don't match."), true;
      el.disabled = true;
      // Face ID first, straight from the tap (browsers only ask for it then).
      const wantBio = !!$('#lockBio')?.checked;
      let bio = '';
      if (wantBio) {
        bioBusy = true;
        bio = await L.bioEnroll();
        bioBusy = false;
      }
      await L.turnOn(p, { away: 1, bio });
      closeSheet();
      toast(bio || !wantBio ? 'App lock is on.' : `App lock is on, with the passcode only: ${L.bioName()} wasn't set up.`);
      hooks.render();
      return true;
    }
    case 'lock-off': {
      el.disabled = true;
      const r = await L.check($('#lockOld')?.value || '');
      el.disabled = false;
      if (r === 'ok') {
        L.turnOff();
        closeSheet();
        toast('App lock is off.');
        hooks.render();
      } else showError(r === 'wait' ? `Too many wrong tries. Try again in ${waitText(L.waitLeft())}.` : 'Wrong passcode.');
      return true;
    }
    case 'lock-off-bio': {
      const l = L.read();
      if (!l || !L.bioUsable(l)) return true;
      bioBusy = true;
      const ok = await L.bioVerify(l.bio);
      bioBusy = false;
      if (!ok) return showError(`${capital(L.bioName())} didn't work. Enter your passcode instead.`), true;
      L.turnOff();
      closeSheet();
      toast('App lock is off.');
      hooks.render();
      return true;
    }
    case 'lock-away':
      L.update({ away: Number(el.dataset.v) });
      hooks.render();
      return true;
    case 'lock-bio': {
      const l = L.read();
      if (!l) return true;
      if (L.bioUsable(l)) L.update({ bio: '', rp: '' });
      else {
        bioBusy = true;
        const id = await L.bioEnroll();
        bioBusy = false;
        if (id) L.update({ bio: id, rp: location.hostname });
        else toast(`${capital(L.bioName())} wasn't set up.`);
      }
      hooks.render();
      return true;
    }
  }
  return false;
}

// Enter in a passcode field does what its button does.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || shown) return;
  const btn = e.target.id === 'lockNew2' || e.target.id === 'lockNew' ? $('[data-act="lock-on"]') : e.target.id === 'lockOld' ? $('[data-act="lock-off"]') : null;
  if (btn) {
    e.preventDefault();
    btn.click();
  }
});
