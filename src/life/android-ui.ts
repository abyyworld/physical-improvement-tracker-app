// Settings, Your life · Android: a switch for each thing the Android app can note for the life
// log (android-sense.ts), what each reads, and what's in the way when Android hasn't allowed it
// yet. On the web and on iPhone it only says this is in the Android app.

import { esc, toast } from '../ui.js';
import * as A from './android-sense';
import type { Sense } from './android-sense';

const WHERE = 'Stays on this phone and in your encrypted sync.';

const ABOUT: Record<Sense, { name: string; reads: string }> = {
  notifications: { name: 'Notifications', reads: 'Which app, who it was from and when, for every app.' },
  calls: { name: 'Calls', reads: 'Calls you made, answered and missed, with names from your contacts.' },
  usage: { name: 'App use', reads: 'How long you spend in each app, hour by hour.' },
  health: { name: 'Health Connect', reads: 'Steps, sleep, workouts and heart rate, once a day.' },
  calendar: { name: 'Calendar', reads: 'The events in your calendars, once they have started.' },
};

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const button = (act: string, label: string, extra = '') => `<button class="btn ghost small" data-act="${act}"${extra}>${label}</button>`;
const err = (text: string, buttons = '') => `<p class="error small">${esc(text)}</p>${buttons ? `<div class="row">${buttons}</div>` : ''}`;

// Under a switch that's on: what's in the way, or how the last read went.
function statusLine(sense: Sense): string {
  const st = A.read();
  const s = A.status;
  const appInfo = button('android-open', 'App info', ' data-screen="app"');
  switch (A.blocked(sense)) {
    case 'access':
      return sense === 'notifications'
        ? err('Arise needs Notification access. Turn on Arise there.', button('android-open', 'Open Notification access', ' data-screen="notifications"'))
        : err('Arise needs Usage access. Turn on Arise there.', button('android-open', 'Open Usage access', ' data-screen="usage"'));
    case 'permission':
      return sense === 'health'
        ? err("Health Connect hasn't allowed Arise to read anything yet.", button('android-allow', 'Allow', ` data-sense="${sense}"`))
        : err(`Android hasn't allowed Arise to read your ${sense === 'calls' ? 'call log' : 'calendar'} yet.`, button('android-allow', 'Allow', ` data-sense="${sense}"`) + appInfo);
    case 'install':
      return err('Install Health Connect from the Play Store first, then tap Allow.', button('android-allow', 'Allow', ` data-sense="${sense}"`));
    case 'unsupported':
      return err("Health Connect doesn't work on this phone.");
  }
  const lines: string[] = [];
  const last = st.last[sense];
  if (last?.error) lines.push(`<p class="error small">The last read didn't work: ${esc(last.error)}</p>`);
  else if (last) lines.push(`<p class="muted small">Read ${ago(last.at)}${last.added ? `: ${last.added} new` : ''}.</p>`);
  else lines.push('<p class="muted small">Not read yet.</p>');
  if (sense === 'notifications') {
    lines.push(`<button class="toggle-row" data-act="android-text" aria-pressed="${st.text}"><span><b>Include what they say</b><small>Off: only which app, who and when.</small></span><span class="switch ${st.text ? 'on' : ''}"></span></button>`);
    if (s.queued) lines.push(`<p class="muted small">${s.queued} waiting to be added.</p>`);
  }
  if (sense === 'calls' && s.contacts && s.contacts !== 'granted') lines.push('<p class="muted small">Without access to your contacts, calls show the name your phone saved with each call, or the number.</p>');
  return lines.join('');
}

export function settingsPanel(): string {
  const title = '<div class="panel-title"><span>Your life · Android</span></div>';
  const about = '<p>Arise can note your calls, notifications, app use, health and calendar, so your coach knows your days.</p>';
  if (!A.inAndroidApp()) {
    return `<section class="panel" id="androidLifePanel">${title}${about}
      <p class="muted small">Android app only.</p>
    </section>`;
  }
  if (!A.supported()) {
    return `<section class="panel" id="androidLifePanel">${title}${about}
      <p class="muted small">Install the newest Arise.apk to use this.</p>
    </section>`;
  }
  const st = A.read();
  const rows = A.SENSES.map((sense) => {
    const on = st.on[sense];
    const a = ABOUT[sense];
    return `<button class="toggle-row" data-act="android-toggle" data-sense="${sense}" aria-pressed="${on}"><span><b>${esc(a.name)}</b><small>${esc(a.reads)} ${WHERE}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>
      ${on ? statusLine(sense) : ''}`;
  }).join('');
  // Android 13 and later hold back Notification access from an app that didn't come from a store.
  const restricted =
    A.status.sdk >= 33 && st.on.notifications && !A.status.notificationAccess
      ? '<p class="muted small">If Android says the setting is restricted: open App info, tap ⋮ at the top, then <b>Allow restricted settings</b>, and try again.</p>'
      : '';
  return `<section class="panel" id="androidLifePanel">${title}
    <p>Arise can note what happens on this phone, so your coach knows your days. Each one is off until you turn it on, and Android asks you first.</p>
    ${rows}
    ${restricted}
  </section>`;
}

// Only the panel changes, so nothing else in Settings (a half-typed form) is touched.
export function refresh() {
  const el = document.getElementById('androidLifePanel');
  if (el) el.outerHTML = settingsPanel();
}

const SAID: Record<A.TurnOn, string> = {
  on: 'On. Arise reads it each time it opens.',
  settings: 'Find Arise on the screen that opened and turn it on, then come back.',
  denied: "Android didn't allow it, so it stays off. You can allow it in App info, under Permissions.",
  install: 'Install Health Connect, then come back and tap Allow.',
  unsupported: "This phone can't do that.",
  error: "That didn't work. Try again.",
};

async function on(sense: Sense) {
  const r = await A.turnOn(sense);
  toast(SAID[r]);
  refresh();
  if (r === 'on') A.collect().then(refresh, () => {});
}

// The panel's buttons. True when it was one of them.
export async function handleAction(act: string, el: HTMLElement): Promise<boolean> {
  const sense = el.dataset.sense as Sense | undefined;
  switch (act) {
    case 'android-toggle':
      if (!sense || !A.SENSES.includes(sense)) return true;
      if (A.read().on[sense]) {
        await A.turnOff(sense);
        toast(`${ABOUT[sense].name} off. What Arise already noted stays in your life log.`);
        refresh();
      } else await on(sense);
      return true;
    case 'android-allow':
      if (sense && A.SENSES.includes(sense)) await on(sense);
      return true;
    case 'android-text':
      await A.setText(!A.read().text);
      refresh();
      return true;
    case 'android-open': {
      const screen = el.dataset.screen;
      if (screen === 'notifications' || screen === 'usage' || screen === 'health' || screen === 'app') {
        if (!(await A.openSettings(screen))) toast("Couldn't open that screen. Look for it in your phone's Settings.");
      }
      return true;
    }
  }
  return false;
}

// Reads on start and whenever the app comes back to the front; the panel follows.
export function initAndroidLife() {
  A.initAndroidSense(refresh);
}

export const forget = () => A.forgetAll();
