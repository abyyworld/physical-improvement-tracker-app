// Settings, Your life (and Your phone on the Connect screen): a switch for each thing the iPhone
// app can read for the life log (sense.ts), and a guide to the iPhone automations that send things
// with "Log to Arise". On the web and on a laptop it only says these are in the iPhone app. Left
// out of a build that has no life log yet, since there'd be nowhere to put what's read.

import { esc, openSheet, toast } from '../ui.js';
import * as SENSE from './sense';
import type { Source } from './sense';
import { hasLifeStore } from './store-port';

const WHERE = 'Stays on this iPhone and in your encrypted sync.';

const ABOUT: Record<Source, { name: string; reads: string }> = {
  health: { name: 'Apple Health', reads: 'Workouts, sleep, steps, heart, weight, mindful minutes and moods. Also what your Apple Watch, ring, scale or other apps save to Health.' },
  motion: { name: 'Motion', reads: 'When you walk, run, cycle or ride in a vehicle, and for how long. Not where.' },
  calendar: { name: 'Calendar', reads: 'Your calendar events: what, when and where.' },
  places: { name: 'Places', reads: 'The places you spend time at and for how long, with names from Apple Maps. Works best with Location set to Always.' },
  shortcuts: { name: 'Shortcuts', reads: 'What your iPhone automations send with “Log to Arise”, like opening an app or getting home.' },
};

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const settingsButton = '<button class="btn ghost small" data-act="life-settings">Open the Settings app</button>';

// What to tell the Player under a switch that's on: how the last read went, or what's in the way.
function statusLine(src: Source): string {
  const st = SENSE.read();
  const s = SENSE.status;
  const err = (text: string, button = '') => `<p class="error small">${esc(text)}</p>${button}`;
  if (src === 'health' && st.noHealth) return err(SENSE.HEALTH_BLOCKED);
  if (src === 'motion' && (s.motion === 'denied' || s.motion === 'restricted')) return err('Motion is off for Arise. Turn on Motion & Fitness for Arise in the Settings app.', settingsButton);
  if (src === 'calendar' && s.calendar && s.calendar !== 'granted' && s.calendar !== 'prompt') return err("Arise can't see your calendars. In the Settings app, open Arise, then Calendars, and choose Full Access.", settingsButton);
  if (src === 'places' && (s.places === 'denied' || s.places === 'restricted')) return err('Location is off for Arise. In the Settings app, open Arise, then Location, and choose Always.', settingsButton);
  if (src === 'shortcuts' && s.shortcuts === false) return err('“Log to Arise” needs iOS 16 or later.');
  const last = st.last[src];
  const lines: string[] = [];
  if (last?.error) lines.push(`<p class="error small">The last read didn't work: ${esc(last.error)}</p>`);
  else if (last) lines.push(`<p class="muted small">Read ${ago(last.at)}${last.added ? `: ${last.added} new` : ''}.</p>`);
  else lines.push(`<p class="muted small">${s.busy ? 'Reading…' : 'Not read yet.'}</p>`);
  if (src === 'places' && s.places === 'whenInUse') lines.push(`<p class="muted small">Location is set to While Using, so places are only noted while Arise is open. Choose Always in the Settings app, under Arise, Location.</p>${settingsButton}`);
  if (src === 'health' && s.moods === false) lines.push('<p class="muted small">Moods need iOS 18 or later.</p>');
  if (src === 'calendar') {
    const add = !!st.addWorkouts;
    lines.push(`<button class="toggle-row" data-act="life-add-workouts" aria-pressed="${add}"><span><b>Add my workouts to my calendar</b><small>Each workout you finish in Arise goes in your calendar.</small></span><span class="switch ${add ? 'on' : ''}"></span></button>`);
  }
  if (src === 'shortcuts') lines.push('<button class="btn ghost small" data-act="life-automations">iPhone automations</button>');
  return lines.join('');
}

// In Settings it's "Your life". The Connect screen gives it its own `name`, which a redraw keeps.
export function settingsPanel(name = ''): string {
  if (!hasLifeStore()) return '';
  const open = `<section class="panel sense-panel" id="lifePanel"${name ? ` data-title="${esc(name)}"` : ''}>`;
  const title = `${open}<div class="panel-title"><span>${esc(name || 'Your life')}</span></div>`;
  if (!SENSE.inIPhoneApp()) {
    return `${title}
      <p>Arise can log your days from Apple Health, motion, your calendar, the places you go and your Shortcuts automations.</p>
      <p class="muted small">iPhone app only.</p>
    </section>`;
  }
  if (!SENSE.supported()) {
    return `${title}
      <p>Arise can log your days from Apple Health, motion, your calendar, the places you go and your Shortcuts automations.</p>
      <p class="muted small">Install the newest Arise.ipa to use this.</p>
    </section>`;
  }
  const st = SENSE.read();
  const rows = SENSE.SOURCES.map((src) => {
    const on = st.on[src];
    const a = ABOUT[src];
    return `<button class="toggle-row" data-act="life-toggle" data-src="${src}" aria-pressed="${on}"><span><b>${esc(a.name)}</b><small>${esc(a.reads)} ${WHERE}</small></span><span class="switch ${on ? 'on' : ''}"></span></button>
      ${on ? statusLine(src) : ''}`;
  }).join('');
  const any = SENSE.SOURCES.some((s) => st.on[s]);
  return `${title}
    <p>Arise can log your days from this iPhone, so your coach knows you better. Each one is off until you turn it on, and Arise reads them each time it opens.</p>
    ${rows}
    ${any ? `<div class="row"><button class="btn ghost small" data-act="life-read" ${SENSE.status.busy ? 'disabled' : ''}>${SENSE.status.busy ? 'Reading…' : 'Read now'}</button></div>` : ''}
  </section>`;
}

// Only the panel changes, so nothing else on the screen (a half-typed form) is touched. (The You
// tab has a "Your life" panel of its own with the same id, which this leaves alone.)
export function refresh() {
  const el = document.querySelector<HTMLElement>('#lifePanel.sense-panel');
  if (el) el.outerHTML = settingsPanel(el.dataset.title);
}

// ---------- the automations guide

const recipe = (name: string, when: string, what: string, extra = '') => `<h3 class="sub">${name}</h3>
    <p><b>Starts when:</b> ${when}</p>
    <p><b>Log to Arise:</b> ${what}</p>${extra ? `<p class="muted small">${extra}</p>` : ''}`;

export function automationsHTML(): string {
  return `<p class="kicker">Your life</p>
    <h2 class="display sheet-title">iPhone automations</h2>
    <p>Your iPhone can tell Arise when things happen, like opening an app or getting home. You set each one up once in the Shortcuts app. Then it runs by itself, even while Arise is closed, and Arise adds it to your day the next time it opens.</p>
    <h3 class="sub">Making one</h3>
    <ol class="changes">
      <li>Open the <b>Shortcuts</b> app and tap <b>Automation</b> at the bottom.</li>
      <li>Tap <b>+</b> at the top (or <b>New Automation</b> if you have none yet).</li>
      <li>Pick what starts it (see below) and set it up.</li>
      <li>Choose <b>Run Immediately</b>. If you see <b>Notify When Run</b>, you can turn it off.</li>
      <li>Tap <b>Next</b>, then <b>New Blank Automation</b>.</li>
      <li>Tap <b>Add Action</b>, search for <b>Arise</b> and pick <b>Log to Arise</b>.</li>
      <li>Fill in <b>What happened</b> and <b>Kind</b> as below, then tap <b>Done</b>.</li>
    </ol>
    ${recipe('Time in an app', '<b>App</b>. Tap Choose, pick one app (Instagram, say), and tick <b>Is Opened</b>.', 'What happened: the app\'s name. Kind: <b>App opened</b>.', 'Then make a second one for the same app with <b>Is Closed</b> and Kind <b>App closed</b>. Arise puts each pair together and shows how long you spent in it. Make a pair for each app you want to count.')}
    ${recipe('Getting somewhere, leaving', '<b>Arrive</b>, then pick a place (Home, Gym…). Make another with <b>Leave</b>.', 'What happened: the place\'s name. Kind: <b>Arrived</b> or <b>Left</b>.', 'With Places on, Arise already notes where you spend time. These add the exact moment for the places that matter to you.')}
    ${recipe('Messages (iOS 17 or later)', '<b>Message</b>. Leave Sender empty, and for <b>Message Contains</b> type a single space. That catches almost every message from anyone (one-word ones like “ok” have no space, so they\'re missed). Or pick a few people under Sender instead.', 'What happened: tap it and choose <b>Shortcut Input</b> (the message). Kind: <b>Message</b>.', 'Arise then keeps who wrote and what they said. If you only want who wrote, tap Shortcut Input once more and pick Sender.')}
    ${recipe('Email', '<b>Email</b>. Pick your <b>Account</b> to catch all its mail, or a Sender or Subject.', 'What happened: <b>Shortcut Input</b>. Kind: <b>Email</b>.')}
    ${recipe('Focus', '<b>Focus</b>, then pick one (Work, Sleep…) and <b>When Turning On</b>. Make another with <b>When Turning Off</b>.', 'What happened: “Work on” or “Work off”. Kind: <b>Focus</b>.')}
    ${recipe('Alarm and sleep', '<b>Alarm</b> with <b>Is Stopped</b>, or <b>Sleep</b> with Bedtime Begins or Waking Up (needs a sleep schedule in the Health app).', 'What happened: “Alarm stopped”, “Bedtime” or “Woke up”. Kind: <b>Alarm</b> or <b>Sleep</b>.')}
    ${recipe('Wi-Fi', '<b>Wi-Fi</b>, then pick a network (your home or work Wi-Fi).', 'What happened: the network\'s name. Kind: <b>Wi-Fi</b>.')}
    ${recipe('CarPlay', '<b>CarPlay</b> with <b>Connects</b> (and another with Disconnects).', 'What happened: “In the car” or “Out of the car”. Kind: <b>CarPlay</b>.')}
    ${recipe('Charger', '<b>Charger</b> with <b>Is Connected</b> (and another with Is Disconnected).', 'What happened: “Plugged in” or “Unplugged”. Kind: <b>Charger</b>.', 'Plugging in at night is a good sign of when you went to bed.')}
    <h3 class="sub">Good to know</h3>
    <p>iPhone doesn't let any app read your calls, other apps' notifications or Screen Time, so automations like these are the way to tell Arise about them.</p>
    <p>Turn <b>Shortcuts</b> on in Settings, Your life, for Arise to keep what they send. ${WHERE}</p>
    <button class="btn primary block" data-act="sheet-close">Got it</button>`;
}

// ---------- taps

// Returns true when it handled the action.
export async function handleAction(act: string, el: HTMLElement): Promise<boolean> {
  switch (act) {
    case 'life-toggle': {
      const src = el.dataset.src as Source;
      if (!SENSE.SOURCES.includes(src)) return true;
      const name = ABOUT[src].name;
      if (SENSE.read().on[src]) {
        await SENSE.turnOff(src);
        toast(`${name} off. What was already read stays in your life log.`);
      } else {
        (el as HTMLButtonElement).disabled = true;
        const note = await SENSE.turnOn(src);
        toast(note || `${name} on.`);
      }
      refresh();
      return true;
    }
    case 'life-add-workouts': {
      const on = !SENSE.read().addWorkouts;
      (el as HTMLButtonElement).disabled = true;
      const note = await SENSE.setAddWorkouts(on);
      toast(note || (on ? 'Your workouts will go in your calendar.' : 'Workouts stay out of your calendar.'));
      refresh();
      return true;
    }
    case 'life-read':
      SENSE.collect(true);
      refresh();
      return true;
    case 'life-automations':
      openSheet(automationsHTML());
      return true;
    case 'life-settings':
      await SENSE.openSettings();
      return true;
  }
  return false;
}

// In the iPhone app: starts reading, and keeps the panel up to date.
export function initLife() {
  SENSE.initSense({ changed: refresh });
}

// Everything on this device is being erased: every source off, nothing left waiting.
export const forget = () => SENSE.forget();

// A workout was just finished: into the calendar, if the Player asked for that.
export const workoutDone = (session: { name?: string; started?: number; finished?: number } | null) => SENSE.workoutDone(session);
