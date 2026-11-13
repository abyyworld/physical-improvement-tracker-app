// Connect: one place for everything Arise can read for your days. Your phone (the iPhone or
// Android app's own switches; on the web, how to get those apps), linked accounts, this computer
// (the browser extension and the Mac helper) and your history from other apps' files.
//
// Each part is the very panel Settings shows, drawn by its own module with a name for this screen.
// So its buttons work the same (app.js hands their taps to each module), and its own redraws,
// which find it by id, land here too and keep that name.

import { esc, icon } from '../ui.js';
import * as CONNECT from '../connect';
import * as SENSE from './sense-ui';
import * as ANDROID from './android-ui';
import * as BROWSER from './browser-ui.js';
import * as MACP from './mac-panel.js';
import * as IMPORT from './import-ui.js';
import { inIPhoneApp } from './sense';
import { inAndroidApp } from './android-sense';
import * as AI from '../ai.js';
import * as S from '../store';
import * as SYNC from '../sync';
import * as WR from '../web-reminders';
import * as ME from '../me';
import * as LOCK from '../lib/lock';
import * as MAC from './mac-link';
import { status as browserStatus } from './browser-link';
import { SERVICES, load as serviceState } from '../connect/state';
import { INFO } from '../connect/engine';
import { countBySource } from './log';
import { SOURCE_NAMES } from './tiers';
import { items as setupItems, progress } from './setup';

export const VIEW = 'connect';
export const LEAD = "Connect what you use, and Arise writes your days from it. Everything stays private: it's read on your devices and only leaves them encrypted.";
// The README's steps for installing the iPhone app, and the newest Android app.
export const IPHONE_HOW = 'https://github.com/abyyworld/physical-improvement-tracker-app#the-iphone-app';
export const ANDROID_APK = 'https://github.com/abyyworld/physical-improvement-tracker-app/releases/download/android-latest/Arise.apk';

// Where it stands, next to its name. (The space keeps them apart when read aloud.)
const chip = (text, on = false) => ` <span class="tag status${on ? ' on' : ''}">${esc(text)}</span>`;

// A row of its own: the name and where it stands, one line of what Arise gets, then what to do.
const row = ({ id, name, status = '', what, note = '', action = '' }) => `<div class="engine hub-row" id="${id}">
    <span class="engine-head"><b>${esc(name)}</b>${status}</span>
    <small>${esc(what)}</small>
    ${note ? `<small class="muted">${esc(note)}</small>` : ''}
    ${action ? `<div class="row">${action}</div>` : ''}
  </div>`;

// The way here, from the Days screen and from Settings.
export function entryRow() {
  return `<button class="panel banner hub-entry" data-act="nav" data-v="${VIEW}"><span>${icon('link')}</span><span><b>Setup and connections</b> <small>See where everything stands. Connect your phone, accounts, this computer, your history and AI apps.</small></span> <span class="go">Open →</span></button>`;
}

// ---------- the parts

const PHONE = 'Your phone';

// In the iPhone or Android app, its own switches. Anywhere else, what each app adds, and where to
// get it.
function phonePart() {
  if (inAndroidApp()) return ANDROID.settingsPanel(PHONE);
  if (inIPhoneApp()) return SENSE.settingsPanel(PHONE);
  return `<section class="panel" id="hubPhone">
    <div class="panel-title">${icon('phone')}<span>${PHONE}</span></div>
    <div class="engines">
      ${row({
        id: 'hub-iphone',
        name: 'iPhone',
        status: chip('Needs the iPhone app'),
        what: 'Health, sleep, steps, workouts, calendar, places and Shortcuts need the Arise app on your iPhone.',
        action: `<a class="btn small ghost" href="${IPHONE_HOW}" target="_blank" rel="noopener">How to get it ${icon('ext')}</a>`,
      })}
      ${row({
        id: 'hub-android',
        name: 'Android',
        status: chip('Needs the Android app'),
        what: 'Calls, missed calls, notifications, app use and Health Connect need the Arise app on your Android phone.',
        action: `<a class="btn small ghost" href="${ANDROID_APK}">Get the Android app</a>`,
      })}
    </div>
    <p class="muted small">iPhones don't let any app read missed calls or other apps' notifications. The Mac helper can, if your iPhone passes calls and notifications to your Mac.</p>
  </section>`;
}

// The browser extension and the Mac helper, each where it can work. In the phone apps, and on a
// computer that isn't a Mac, a line says where instead.
function computerPart() {
  const browser = inIPhoneApp()
    ? row({ id: 'hub-browser', name: 'Browser', status: chip('On a computer'), what: 'The sites you visit, what you search, and your time on each site.', note: 'Open Arise in Chrome, Edge, Brave, Arc or Firefox on your computer to add it.' })
    : BROWSER.browserPanel('Browser');
  const mac =
    MACP.settingsPanel('Mac') ||
    row({ id: 'hub-mac', name: 'Mac', status: chip('Mac only'), what: 'Calls (missed ones from your iPhone too), notifications, Messages, Safari and app use, through a small helper on your Mac.' });
  return `<section class="panel hub-sec" id="hubComputer">
    <div class="panel-title">${icon('laptop')}<span>This computer</span></div>
    <div class="engines">${browser}${mac}</div>
  </section>`;
}

function historyPart() {
  return `<section class="panel" id="hubHistory">
    <div class="panel-title">${icon('days')}<span>Your history</span></div>
    <div class="engines">
      ${row({
        id: 'hub-history',
        name: 'Files from your apps',
        what: 'Google Takeout, Maps Timeline, Spotify, Netflix, Apple Health, WhatsApp and bank statements. Arise reads the file on this device.',
        action: IMPORT.importButton('Bring in your history', 'btn small primary'),
      })}
    </div>
  </section>`;
}

// ---------- your setup: everything worth setting up, where each stands, and what's next

// Sources a file brings in (not the phone or this computer, which have parts of their own).
const FROM_FILES = ['google', 'youtube', 'chrome', 'maps', 'spotify', 'netflix', 'health', 'whatsapp', 'bank'];
let history = null; // the names of what was brought in, once counted

function facts() {
  const links = ME.links();
  const e = AI.engine();
  return {
    // Web reminders only where this browser can have them (or after Add to Home Screen).
    configured: { sync: SYNC.configured, reminders: WR.supported() || WR.needsHomeScreen() },
    signedIn: !!SYNC.status.user,
    ai: { engine: e, label: e === 'private' ? 'Private AI' : e === 'device' ? 'The AI on this device' : e === 'local' ? "Your computer's AI" : e === 'free' ? 'Free AI' : e === 'own' ? 'Your own AI service' : '', private: AI.isPrivate() },
    reminders: inIPhoneApp() || inAndroidApp() ? !!S.state.settings.notify : WR.isOn(),
    // (inIPhoneApp is true in any phone app: Android first, as phonePart does.)
    native: inAndroidApp() ? 'android' : inIPhoneApp() ? 'ios' : null,
    lock: LOCK.isOn(),
    accounts: SERVICES.filter((id) => serviceState(id).on).map((id) => INFO[id].name),
    computer: { browser: browserStatus.links.length > 0, mac: MAC.linked() },
    history,
    apps: { all: links.length, web: links.filter((l) => ME.webNow(l)).length },
  };
}

// Counts what's in the life log by source, then draws the setup again with it.
async function countHistory() {
  try {
    const by = await countBySource();
    history = FROM_FILES.filter((x) => by[x]).map((x) => SOURCE_NAMES[x]);
  } catch {
    history = [];
  }
  repaintSetup();
}

const mark = (done) => `<span class="setup-mark ${done ? 'on' : ''}" aria-hidden="true">${done ? icon('check') : ''}</span>`;
const goButton = (it, cls = 'btn small ghost') => `<button class="${cls}" data-act="hub-go" data-v="${esc(it.go.view)}" data-to="${esc(it.go.to)}" aria-label="${esc(`${it.go.label}: ${it.name}`)}">${esc(it.go.label)}</button>`;

export function setupPanel() {
  const list = setupItems(facts());
  const { done, all, next } = progress(list);
  if (history === null) void countHistory();
  return `<section class="panel setup" id="hubSetup">
    <div class="panel-title">${icon('check')}<span>Your setup</span>${chip(`${done} of ${all}`, done === all)}</div>
    <div class="setup-bar" role="progressbar" aria-label="Set up" aria-valuemin="0" aria-valuemax="${all}" aria-valuenow="${done}"><span style="width:${Math.round((done / all) * 100)}%"></span></div>
    ${next ? `<p class="small setup-next"><b>Next: ${esc(next.name)}.</b> ${esc(next.what)} ${goButton(next, 'btn small primary')}</p>` : '<p class="small setup-next"><b>All set up.</b> Change anything here, any time.</p>'}
    <ul class="setup-list">${list
      .map(
        (it) => `<li class="setup-item${it.done ? ' done' : ''}" id="setup-${it.id}">
        ${mark(it.done)}
        <div class="setup-body"><span class="engine-head"><b>${esc(it.name)}</b>${it.recommended && !it.done ? chip('Recommended') : ''}${it.less ? ' <span class="tag less">Less private</span>' : ''}</span>
          <small>${esc(it.status)}</small>
          <small class="muted">${esc(it.what)}</small></div>
        ${goButton(it)}
      </li>`,
      )
      .join('')}</ul>
    <div class="row"><button class="link" data-act="hub-check">Check again</button></div>
  </section>`;
}

// Panels on this screen redraw on their own when something is linked; the setup follows.
let watching = false;
function watchPanels() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  let queued = false;
  new MutationObserver((changes) => {
    if (queued || !changes.some((c) => c.target instanceof Element && !c.target.closest('#hubSetup') && c.target.closest('.hub'))) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      repaintSetup();
    });
  }).observe(globalThis.document.getElementById('app') || globalThis.document.body, { childList: true, subtree: true });
}

function repaintSetup() {
  const el = globalThis.document?.getElementById('hubSetup');
  if (el) el.outerHTML = setupPanel();
}

// The taps this screen has itself. `go` is app.js's, to open another screen.
export async function handleAction(act, el, { go } = {}) {
  if (act === 'hub-go') {
    const { v, to } = el.dataset;
    // Already on this screen: only scroll. Otherwise open that screen first (it draws at once).
    if (!(v === VIEW && globalThis.document?.querySelector('#app .hub'))) go?.(v, { scroll: false });
    const target = globalThis.document?.getElementById(to);
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    } else globalThis.scrollTo?.(0, 0);
    return true;
  }
  if (act === 'hub-check') {
    history = null;
    if (ME.links().some((l) => l.web)) void ME.checkConnector();
    repaintSetup();
    return true;
  }
  return false;
}

// ---------- the screen

export function renderConnect(root) {
  history = null; // counted again: something may have been brought in since
  watchPanels();
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="days" aria-label="Back to your days">${icon('back')}</button><div><p class="kicker">Setup and connections</p><h1 class="display">Connect</h1></div></header>
    <p class="hub-lead">${esc(LEAD)}</p>
    ${setupPanel()}
    <div class="cols hub">
      <div class="col">${phonePart()}${CONNECT.settingsPanel('Accounts')}</div>
      <div class="col">${computerPart()}${historyPart()}</div>
    </div>`;
}
