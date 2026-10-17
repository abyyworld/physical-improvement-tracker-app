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
  return `<button class="panel banner hub-entry" data-act="nav" data-v="${VIEW}"><span>${icon('link')}</span><span><b>Connect apps and devices</b> <small>Your phone, your accounts, this computer and your history.</small></span> <span class="go">Open →</span></button>`;
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

// ---------- the screen

export function renderConnect(root) {
  root.innerHTML = `
    <header class="page-head life-back-head"><button class="icon-btn" data-act="nav" data-v="days" aria-label="Back to your days">${icon('back')}</button><div><p class="kicker">Your life, from everywhere</p><h1 class="display">Connect</h1></div></header>
    <p class="hub-lead">${esc(LEAD)}</p>
    <div class="cols hub">
      <div class="col">${phonePart()}${CONNECT.settingsPanel('Accounts')}</div>
      <div class="col">${computerPart()}${historyPart()}</div>
    </div>`;
}
