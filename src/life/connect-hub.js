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
import { items as setupItems, progress, STEPS } from './setup';
import * as SYS from '../system.js';
import * as APPLOCK from '../app-lock.js';

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
const goButton = (it, cls = 'btn small ghost') => `<button class="${cls}" data-act="hub-go" data-v="${esc(it.go.view)}" data-to="${esc(it.go.to)}"${it.go.step ? ` data-step="${esc(it.go.step)}"` : ''} aria-label="${esc(`${it.go.label}: ${it.name}`)}">${esc(it.go.label)}</button>`;

export function setupPanel() {
  const list = setupItems(facts());
  const { done, all, next } = progress(list);
  if (history === null) void countHistory();
  return `<section class="panel setup-card" id="hubSetup">
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
    const { v, to, step: s } = el.dataset;
    const onWiz = !!globalThis.document?.querySelector('#app .wiz');
    // A step of the setup here: that step's Connect tab. Already on this screen: only scroll.
    // Otherwise open that screen first (it draws at once).
    if (v === VIEW && s && STEPS.some((x) => x.id === s)) {
      wiz.step = s;
      wiz.tab = 'connect';
      wiz.page = 0;
      if (onWiz) rerender();
      else go?.(v, { scroll: false });
    } else if (!(v === VIEW && onWiz)) go?.(v, { scroll: false });
    const target = globalThis.document?.getElementById(to);
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 1600);
    } else globalThis.scrollTo?.(0, 0);
    return true;
  }
  if (act === 'hub-step') {
    const s = el.dataset.s;
    if (!STEPS.some((x) => x.id === s)) return true;
    wiz.step = s;
    wiz.tab = defaultTab(s);
    wiz.page = 0;
    rerender();
    globalThis.document?.querySelector('.wiz-main')?.scrollIntoView?.({ block: 'start' });
    return true;
  }
  if (act === 'hub-tab') {
    wiz.tab = el.dataset.t === 'guide' ? 'guide' : 'connect';
    wiz.page = 0;
    rerender();
    return true;
  }
  if (act === 'hub-page') {
    const n = (GUIDES[wiz.step] || []).length;
    wiz.page = Math.max(0, Math.min(n - 1, wiz.page + Number(el.dataset.n || 0)));
    rerender();
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

// ---------- the screen: setup in four steps
//
// A rail of steps (Your account, Your AI coach, Connections, Review) with where each stands, the
// step's own page with a progress bar, chips for what it is and whether it's done, and two tabs:
// Guide (what to do, a few short steps with Previous and Next) and Connect (the very panels that
// do it, the same as in Settings). Review lists every part with its status.

const wiz = { step: '', tab: 'connect', page: 0 };
let rootEl = null;
const rerender = () => rootEl && renderConnect(rootEl, { keep: true });

const defaultTab = (s) => (s === 'connections' || s === 'review' ? 'connect' : stepDone(s) ? 'connect' : 'guide');

function stepDone(s, list = setupItems(facts())) {
  const mine = list.filter((i) => (i.go.step || 'connections') === s);
  if (s === 'review') return list.every((i) => i.done || !i.recommended);
  return mine.length > 0 && mine.filter((i) => i.recommended).every((i) => i.done) && mine.some((i) => i.done);
}

// Short guides for each step, in plain words. `art`: the picture's icon.
const GUIDES = {
  account: [
    { art: 'person', title: 'Make an account', text: "With your email and a password, or with an account code if you'd rather not give an email. It's free." },
    { art: 'key', title: 'Keep your recovery code', text: "Arise shows it once. Write it down somewhere safe: it's the only way back in if you forget your password, because nobody else can read your data." },
    { art: 'phone', title: 'Sign in on your other devices', text: 'Use the same email and password. Everything syncs between them, end-to-end encrypted.' },
    { art: 'lock', title: 'Lock the app, if you like', text: 'A passcode, or Face ID or Touch ID, each time Arise opens on this device.' },
  ],
  ai: [
    { art: 'system', title: 'Pick where your coach thinks', text: 'The private AI is the default: a sealed enclave that nobody can read, not even the people who run it. It needs your account.' },
    { art: 'laptop', title: 'Or keep it on your own machine', text: "The AI in your browser on a laptop, or your computer's own (Ollama or LM Studio), never sends anything anywhere." },
    { art: 'key', title: 'Or use your own key', text: 'Gemini, Claude or ChatGPT with your own key. Less private: that company can read what the coach sends. Arise asks first.' },
  ],
  connections: [
    { art: 'phone', title: 'Your phone', text: 'The iPhone or Android app reads sleep, steps, workouts, places and your calendar into your days by itself.' },
    { art: 'link', title: 'Your accounts', text: 'Link Google or Microsoft for your calendar and email, Steam or PlayStation for your games. Read straight from this device.' },
    { art: 'laptop', title: 'This computer', text: 'The browser extension adds the sites you visit; on a Mac, the helper adds calls, messages and app use.' },
    { art: 'days', title: 'Your history', text: 'Bring in years of your life from Google, Spotify, Netflix, Apple Health and more. The file is read on this device.' },
    { art: 'share', title: 'AI apps', text: 'Let Claude, ChatGPT or Gemini know you, with only what you pick for each. On the web it is less private, and off until you turn it on.' },
  ],
};

function illo(name) {
  return `<div class="wiz-art" aria-hidden="true"><span class="wiz-art-orb"></span><span class="wiz-art-icon">${icon(name)}</span><i></i><i></i><i></i></div>`;
}

function guideHTML(s) {
  const steps = GUIDES[s] || [];
  if (!steps.length) return '';
  const i = Math.min(wiz.page, steps.length - 1);
  const g = steps[i];
  return `<div class="wiz-guide">
    <div class="wiz-guide-text">
      <p class="wiz-guide-n">${i + 1} of ${steps.length}</p>
      <h3>${esc(g.title)}</h3>
      <p>${esc(g.text)}</p>
      <div class="wiz-pager">
        <button class="btn ghost small" data-act="hub-page" data-n="-1" ${i === 0 ? 'disabled' : ''}>‹ Previous</button>
        <span class="muted small">${i + 1} / ${steps.length}</span>
        ${i < steps.length - 1 ? '<button class="btn ghost small" data-act="hub-page" data-n="1">Next ›</button>' : '<button class="btn primary small" data-act="hub-tab" data-t="connect">Set it up</button>'}
      </div>
    </div>
    ${illo(g.art)}
  </div>`;
}

function connectHTML(s) {
  if (s === 'account') return `${SYNC.panel()}${APPLOCK.settingsPanel()}`;
  if (s === 'ai') return SYS.settingsPanels();
  if (s === 'review') return setupPanel();
  return `<div class="cols hub">
      <div class="col">${phonePart()}${CONNECT.settingsPanel('Accounts')}</div>
      <div class="col">${computerPart()}${historyPart()}${appsPart()}</div>
    </div>`;
}

// AI apps and other apps, from What Arise knows.
function appsPart() {
  const links = ME.links();
  const web = links.filter((l) => ME.webNow(l)).length;
  return `<section class="panel" id="hubApps">
    <div class="panel-title">${icon('share')}<span>AI apps</span></div>
    <div class="engines">
      ${row({
        id: 'hub-apps',
        name: 'Claude, ChatGPT, Gemini and others',
        status: chip(links.length ? `${links.length} connected` : 'None yet', links.length > 0),
        what: 'Give each app its own private link, with only what you pick. On the web it is marked less private and stays off until you turn it on.',
        note: web ? `${web} on the web.` : '',
        action: '<button class="btn small primary" data-act="nav" data-v="knows">Connected apps</button>',
      })}
    </div>
  </section>`;
}

function chipsFor(s, list) {
  const mine = list.filter((i) => (i.go.step || 'connections') === s);
  const rec = mine.some((i) => i.recommended);
  const done = stepDone(s, list);
  const less = mine.some((i) => i.less);
  return `${s === 'review' ? '' : `<span class="tag wiz-chip">${rec ? 'Recommended' : 'Optional'}</span>`}<span class="tag wiz-chip ${done ? 'ok' : ''}">${done ? 'Set up' : 'Not set up yet'}</span>${less ? '<span class="tag less">Less private</span>' : ''}`;
}

const STEP_TEXT = {
  account: 'The same Arise on all your devices, and a copy in the cloud that only you can read.',
  ai: 'A coach that knows your days, writes your journal and learns what helps you.',
  connections: LEAD,
  review: 'Everything in one place: what is set up, and what is still to do.',
};

export function renderConnect(root, { keep = false } = {}) {
  rootEl = root;
  if (!keep) history = null; // counted again: something may have been brought in since
  watchPanels();
  const list = setupItems(facts());
  if (!wiz.step) {
    wiz.step = STEPS.find((x) => x.id !== 'review' && x.id !== 'connections' && list.some((i) => i.go.step === x.id) && !stepDone(x.id, list))?.id || 'connections';
    wiz.tab = defaultTab(wiz.step);
  }
  // A step with nothing in this copy of Arise (no cloud: no account): the next one.
  if (wiz.step === 'account' && !SYNC.configured) wiz.step = 'ai';
  const n = STEPS.findIndex((x) => x.id === wiz.step);
  const { done, all } = progress(list);
  const title = STEPS[n].name;
  const guide = !!GUIDES[wiz.step];
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="days" aria-label="Back to your days">${icon('back')}</button><div><p class="kicker">Setup and connections</p><h1 class="display">Connect</h1></div></header>
    <div class="wiz">
      <nav class="wiz-rail" aria-label="Setup steps">
        ${STEPS.map((x, i) => `<button class="wiz-step${x.id === wiz.step ? ' on' : ''}${stepDone(x.id, list) ? ' done' : ''}" data-act="hub-step" data-s="${x.id}" aria-current="${x.id === wiz.step ? 'step' : 'false'}"><span class="wiz-num">${stepDone(x.id, list) ? icon('check') : i + 1}</span><span>${esc(x.name)}</span></button>`).join('')}
        <p class="wiz-total muted small">${done} of ${all} parts set up</p>
      </nav>
      <div class="wiz-main">
        <div class="wiz-top"><span class="muted small">Step ${n + 1} of ${STEPS.length}</span><button class="link small" data-act="hub-check">Check again</button></div>
        <div class="wiz-bar" role="progressbar" aria-label="Steps" aria-valuemin="1" aria-valuemax="${STEPS.length}" aria-valuenow="${n + 1}"><span style="width:${((n + 1) / STEPS.length) * 100}%"></span></div>
        <div class="wiz-head"><h2 class="display">${esc(title)}</h2>${chipsFor(wiz.step, list)}</div>
        <p class="hub-lead">${esc(STEP_TEXT[wiz.step])}</p>
        ${
          guide
            ? `<div class="wiz-tabs" role="tablist"><button role="tab" class="${wiz.tab === 'guide' ? 'on' : ''}" aria-selected="${wiz.tab === 'guide'}" data-act="hub-tab" data-t="guide">Guide</button><button role="tab" class="${wiz.tab === 'connect' ? 'on' : ''}" aria-selected="${wiz.tab === 'connect'}" data-act="hub-tab" data-t="connect">Connect</button></div>`
            : ''
        }
        <div class="wiz-body">${guide && wiz.tab === 'guide' ? guideHTML(wiz.step) : connectHTML(wiz.step)}</div>
        <div class="wiz-foot">
          ${n > 0 ? `<button class="btn ghost small" data-act="hub-step" data-s="${STEPS[n - 1].id}">Back</button>` : '<span></span>'}
          ${n < STEPS.length - 1 ? `<button class="btn primary" data-act="hub-step" data-s="${STEPS[n + 1].id}">${n === STEPS.length - 2 ? 'Review setup' : 'Continue'}</button>` : '<button class="btn primary" data-act="nav" data-v="today">Go to Today</button>'}
        </div>
      </div>
    </div>`;
}

// Opens on a step (tests, and links that want one).
export function openStep(s) {
  if (!STEPS.some((x) => x.id === s)) return;
  wiz.step = s;
  wiz.tab = defaultTab(s);
  wiz.page = 0;
}

// For tests: start again from the first step.
export function _resetSetup() {
  wiz.step = '';
  wiz.tab = 'connect';
  wiz.page = 0;
}
