// Your life, Android: what the Android app can note about the Player's days, for the life log.
//
//   notifications  which app and when from every app, who for messages, calls and emails (the
//                  rest of the title and the text too, only if they say so)
//   calls          calls made, answered and missed, with names from the contacts
//   usage          time spent in each app, hour by hour
//   health         steps, sleep, workouts and heart rate from Health Connect, once a day
//   calendar       the events in the phone's calendars, once they've started
//
// Each is off until the Player turns it on (Settings, Your life · Android, see android-ui.ts),
// and each needs Android's own permission too. Arise's Android plugin (android/app/src/main/java/
// com/abyyworld/arise/life) reads the phone only when this asks, while the app is open. The one
// exception is notifications: Android hands them to Arise as they come, and they wait in a file
// in the app's own storage until the app is opened. Then they're added to the life log and only
// after that deleted from the file, so none is lost if the app is closed halfway.
//
// Everything goes to the life log through lifeStore() (store-port.ts), as LifeEvents with stable
// ids, so reading the same thing twice adds nothing. Calls, notifications, sleep and heart rate are
// tier 3 (sensitive); app use, steps, workouts and calendar events tier 2. Nothing is sent anywhere
// from here: the life log keeps it on the phone and in the Player's end-to-end encrypted sync.
//
// What's on, and how far each has been read, belong to this phone: kept in localStorage, never
// synced and never in backups.

import type { LifeEvent } from './types';
import { hasLifeStore, lifeStore } from './store-port';

export type Sense = 'notifications' | 'calls' | 'usage' | 'health' | 'calendar';
export const SENSES: Sense[] = ['notifications', 'calls', 'usage', 'health', 'calendar'];

const PLUGIN = 'AriseLife';
const KEY = 'arise-android-sense';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// How far back the first read goes, when one is turned on.
const BACK = { calls: 30 * DAY, usage: 7 * DAY, health: 30 * DAY, calendar: 30 * DAY };
// Calendar events can be added or moved after they happen, so each read looks a little further back.
const CALENDAR_AGAIN = 2 * DAY;
// Health data can arrive late (a watch syncing), so a day is read once it's half a day over.
const SETTLE = 12 * HOUR;

// ---------- the plugin

interface Cap {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  PluginHeaders?: { name: string }[];
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const cap = () => (globalThis as { Capacitor?: Cap }).Capacitor;
// The Android app (any copy of it).
export const inAndroidApp = () => !!cap()?.isNativePlatform?.() && cap()?.getPlatform?.() === 'android';
// One with Arise's own plugin (every Arise.apk has it).
export const supported = () => inAndroidApp() && !!cap()?.PluginHeaders?.some((h) => h.name === PLUGIN);
const call = <T = Record<string, unknown>>(method: string, options: object = {}) => cap()!.nativePromise(PLUGIN, method, options) as Promise<T>;

// ---------- this phone's settings

interface Last {
  at: number; // when it was last read
  added: number; // how many new events that read added
  error?: string;
}

export interface SenseState {
  on: Record<Sense, boolean>;
  text: boolean; // notifications with their text, not just who and when
  // How far each has been read: calls up to this time, app use up to this hour, health up to
  // this day (whole days only) and sessions to this time, the calendar to this time.
  calls?: number;
  usage?: number;
  healthDay?: string;
  health?: number;
  calendar?: number;
  last: Partial<Record<Sense, Last>>;
}

const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.floor(v) : undefined);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Whatever is in storage, only the parts that make sense.
export function cleanState(raw: unknown): SenseState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const on = (r.on && typeof r.on === 'object' ? r.on : {}) as Record<string, unknown>;
  const lastIn = (r.last && typeof r.last === 'object' ? r.last : {}) as Record<string, unknown>;
  const last: Partial<Record<Sense, Last>> = {};
  for (const s of SENSES) {
    const l = lastIn[s] as Record<string, unknown> | undefined;
    const at = time(l?.at);
    if (!l || !at) continue;
    last[s] = { at, added: Math.max(0, Math.floor(Number(l.added) || 0)) };
    if (typeof l.error === 'string' && l.error) last[s]!.error = l.error.slice(0, 200);
  }
  const st: SenseState = {
    on: Object.fromEntries(SENSES.map((s) => [s, on[s] === true])) as Record<Sense, boolean>,
    text: r.text === true,
    last,
  };
  for (const k of ['calls', 'usage', 'health', 'calendar'] as const) {
    const t = time(r[k]);
    if (t) st[k] = t;
  }
  if (isDay(r.healthDay)) st.healthDay = r.healthDay;
  return st;
}

export function read(): SenseState {
  try {
    return cleanState(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return cleanState({});
  }
}

function write(st: SenseState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
}

const update = (change: (st: SenseState) => void) => {
  const st = read();
  change(st);
  write(st);
  return st;
};

// ---------- turning rows from the phone into life events

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
// Part of an id: printable, no spaces (the life log's rule), and not too long.
const idPart = (v: string) => (/^[\x21-\x7e]{1,120}$/.test(v) ? v : hash(v));

// A short fingerprint of a text (cyrb53), for ids made from several parts.
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// "1 h 20 min", "45 min", "under a minute".
export function minutes(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const ANDROID = { device: 'android' } as const;

// A notification another app showed (NotificationRecorder.kt). `withText`: keep what it said;
// otherwise only which app, who and when. The title is "who" only where the recorder marks it as a
// person (`person`: a message, a call or an email); anywhere else (a bank alert, a delivery) it
// says what happened, so it's kept only with the text, and the event is just the app and when.
export function notificationEvent(raw: unknown, withText: boolean): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const pkg = str(r.pkg, 200);
  const at = time(r.at);
  const app = str(r.app, 80) || pkg;
  const marked = typeof r.person === 'boolean';
  const who = withText || r.person !== false ? str(r.title, 200) : '';
  if (!pkg || !at || (!who && !(withText && str(r.text)) && !marked)) return null;
  const e: LifeEvent = {
    id: `other:android-note:${hash(`${pkg}|${str(r.key, 400)}|${at}`)}`,
    source: 'other',
    kind: 'notification',
    at,
    title: who ? `${app}: ${who}` : app,
    tier: 3,
    meta: { ...ANDROID, app, pkg },
  };
  const text = withText ? str(r.text, 1000) : '';
  if (text) e.detail = text;
  return e;
}

// Android's call types (CallLog.Calls.TYPE).
export const CALL = { incoming: 1, outgoing: 2, missed: 3, voicemail: 4, rejected: 5, blocked: 6, elsewhere: 7 } as const;

// Who a call was with, in words.
function caller(r: Record<string, unknown>): string {
  const name = str(r.name, 120);
  if (name) return name;
  const number = str(r.number, 40);
  // Android's number presentation: 2 private, 3 unknown, 4 payphone.
  if (r.presentation === 2) return 'a private number';
  if (!number || number.startsWith('-') || r.presentation === 3 || r.presentation === 4) return 'an unknown number';
  return number;
}

// A row of the call log (CallReader in Readers.kt). Missed, declined and blocked calls say so.
export function callEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const at = time(r.date);
  const id = num(r.id);
  const type = num(r.type);
  if (!at || !Number.isInteger(id)) return null;
  const secs = Math.max(0, Math.floor(num(r.duration) || 0));
  const who = caller(r);
  const long = secs ? ` (${minutes(secs * 1000)})` : '';
  let title: string;
  let missed = false;
  let direction: 'in' | 'out' = 'in';
  switch (type) {
    case CALL.outgoing:
      direction = 'out';
      title = secs ? `Called ${who}${long}` : `Called ${who} (no answer)`;
      break;
    case CALL.missed:
      missed = true;
      title = `Missed call from ${who}`;
      break;
    case CALL.voicemail:
      missed = true;
      title = `Voicemail from ${who}`;
      break;
    case CALL.rejected:
      missed = true;
      title = `Declined a call from ${who}`;
      break;
    case CALL.blocked:
      missed = true;
      title = `Blocked a call from ${who}`;
      break;
    case CALL.elsewhere:
      title = `Call from ${who}, answered on another device`;
      break;
    case CALL.incoming:
      title = `Call from ${who}${long}`;
      break;
    default:
      return null;
  }
  const e: LifeEvent = {
    id: `other:android-call:${at}-${id}`,
    source: 'other',
    kind: 'call',
    at,
    title,
    tier: 3,
    meta: { ...ANDROID, direction, missed },
  };
  if (secs && !missed) {
    e.end = at + secs * 1000;
    e.value = secs;
    e.unit = 's';
  }
  const name = str(r.name, 120);
  const number = str(r.number, 40);
  if (name) e.meta!.name = name;
  if (number && !number.startsWith('-')) e.meta!.number = number;
  return e;
}

// Time in one app in one hour (UsageReader in Readers.kt). Less than a minute isn't worth noting.
export function usageEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const pkg = str(r.pkg, 200);
  const hour = time(r.hour);
  const ms = num(r.ms);
  if (!pkg || !hour || !(ms >= MIN) || ms > HOUR + MIN) return null;
  const app = str(r.app, 80) || pkg;
  return {
    id: `other:android-app:${idPart(pkg)}:${hour}`,
    source: 'other',
    kind: 'app',
    at: hour,
    title: `Used ${app} for ${minutes(ms)}`,
    value: Math.round(ms / MIN),
    unit: 'min',
    tier: 2,
    meta: { ...ANDROID, app, pkg },
  };
}

// Midnight at the start of a day ("2026-10-16") on this phone's clock.
const dayStart = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const dayAfter = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + 1).getTime();
};
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A whole day from Health Connect (HealthReader.days): steps, and the heart rate's range.
export function healthDayEvents(raw: unknown): LifeEvent[] {
  const r = (raw || {}) as Record<string, unknown>;
  if (!isDay(r.day)) return [];
  const at = dayStart(r.day);
  const end = dayAfter(r.day);
  const out: LifeEvent[] = [];
  const steps = num(r.steps);
  if (steps > 0) {
    out.push({
      id: `health:hc-steps:${r.day}`,
      source: 'health',
      kind: 'steps',
      at,
      end,
      title: `${Math.round(steps).toLocaleString('en-US')} steps`,
      value: Math.round(steps),
      unit: 'steps',
      tier: 2,
      meta: { ...ANDROID, from: 'Health Connect' },
    });
  }
  const avg = num(r.hrAvg);
  if (avg > 0) {
    const low = num(r.hrMin);
    const high = num(r.hrMax);
    out.push({
      id: `health:hc-heart:${r.day}`,
      source: 'health',
      kind: 'health',
      at,
      end,
      title: low > 0 && high > 0 ? `Heart rate ${Math.round(low)} to ${Math.round(high)}, ${Math.round(avg)} on average` : `Heart rate ${Math.round(avg)} on average`,
      value: Math.round(avg),
      unit: 'bpm',
      tier: 3,
      meta: { ...ANDROID, from: 'Health Connect' },
    });
  }
  return out;
}

// A night's sleep or a workout from Health Connect (HealthReader.sessions).
export function healthSessionEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const id = str(r.id, 200);
  const at = time(r.start);
  const end = time(r.end);
  if (!id || !at || !end || end <= at) return null;
  const length = minutes(end - at);
  const mins = Math.round((end - at) / MIN);
  const meta = { ...ANDROID, from: 'Health Connect' };
  if (r.kind === 'sleep') {
    // The life log counts sleep as sensitive (tier 3), like other health details.
    return { id: `health:hc-sleep:${idPart(id)}`, source: 'health', kind: 'sleep', at, end, title: `Slept ${length}`, value: mins, unit: 'min', tier: 3, meta };
  }
  if (r.kind === 'workout') {
    const name = str(r.title, 120) || str(r.type, 60) || 'Workout';
    return { id: `health:hc-workout:${idPart(id)}`, source: 'health', kind: 'workout', at, end, title: `${name}, ${length}`, value: mins, unit: 'min', tier: 2, meta };
  }
  return null;
}

// An event from the phone's calendars (CalendarReader in Readers.kt).
export function calendarEvent(raw: unknown): LifeEvent | null {
  const r = (raw || {}) as Record<string, unknown>;
  const id = num(r.id);
  let at = time(r.begin);
  let end = time(r.end);
  if (!at || !Number.isInteger(id)) return null;
  const allDay = r.allDay === true;
  // An all-day event is kept by its date (Android stores it at midnight UTC).
  if (allDay) {
    const start = new Date(at).toISOString().slice(0, 10);
    const days = end ? Math.max(1, Math.round((end - at) / DAY)) : 1;
    at = dayStart(start);
    end = new Date(at).setDate(new Date(at).getDate() + days);
  }
  const e: LifeEvent = {
    id: `calendar:android:${id}-${time(r.begin)}`,
    source: 'calendar',
    kind: 'event',
    at,
    title: str(r.title, 200) || 'Busy',
    tier: 2,
    meta: { ...ANDROID, allDay },
  };
  if (end && end > at) e.end = end;
  return e;
}

// ---------- what the phone allows

export interface PhoneStatus {
  ready: boolean; // asked the phone at least once
  sdk: number; // Android's API level (33 is Android 13)
  notificationAccess: boolean;
  queued: number;
  usageAccess: boolean;
  health: 'available' | 'install' | 'unsupported' | '';
  healthGranted: string[];
  calls: string; // 'granted', 'denied', 'prompt'…
  contacts: string;
  calendar: string;
}

export const status: PhoneStatus = { ready: false, sdk: 0, notificationAccess: false, queued: 0, usageAccess: false, health: '', healthGranted: [], calls: '', contacts: '', calendar: '' };

export async function refreshStatus(): Promise<PhoneStatus> {
  if (!supported()) return status;
  try {
    const s = await call('status');
    const p = await call('checkPermissions');
    Object.assign(status, {
      ready: true,
      sdk: num(s.sdk) || 0,
      notificationAccess: s.notificationAccess === true,
      queued: num(s.queued) || 0,
      usageAccess: s.usageAccess === true,
      health: s.health === 'available' || s.health === 'install' ? s.health : 'unsupported',
      healthGranted: Array.isArray(s.healthGranted) ? s.healthGranted.filter((x): x is string => typeof x === 'string') : [],
      calls: str(p.calls, 30),
      contacts: str(p.contacts, 30),
      calendar: str(p.calendar, 30),
    });
  } catch {}
  return status;
}

// What's in the way of one that's on ('' when nothing).
export function blocked(sense: Sense): '' | 'access' | 'permission' | 'install' | 'unsupported' {
  if (!status.ready) return '';
  switch (sense) {
    case 'notifications':
      return status.notificationAccess ? '' : 'access';
    case 'usage':
      return status.usageAccess ? '' : 'access';
    case 'calls':
      return status.calls === 'granted' ? '' : 'permission';
    case 'calendar':
      return status.calendar === 'granted' ? '' : 'permission';
    case 'health':
      return status.health === 'unsupported' ? 'unsupported' : status.health === 'install' ? 'install' : status.healthGranted.length ? '' : 'permission';
  }
}

// ---------- turning them on and off

export type TurnOn = 'on' | 'settings' | 'denied' | 'install' | 'unsupported' | 'error';

// Turns one on and asks Android for what it needs. 'settings': the phone's settings screen was
// opened for the Player to give access; 'denied': they said no, so it's off.
export async function turnOn(sense: Sense): Promise<TurnOn> {
  if (!supported()) return 'unsupported';
  const result = await ask(sense);
  const st = update((s) => {
    if (result === 'denied' || result === 'unsupported') s.on[sense] = false;
    else if (result !== 'error') s.on[sense] = true;
  });
  // The recorder never runs while the switch shows off.
  if (sense === 'notifications' && !st.on.notifications) await call('setNotifications', { on: false, text: false }).catch(() => {});
  await refreshStatus();
  return result;
}

async function ask(sense: Sense): Promise<TurnOn> {
  try {
    let result: TurnOn = 'on';
    if (sense === 'notifications') {
      const st = read();
      await call('setNotifications', { on: true, text: st.text });
      await refreshStatus();
      if (!status.notificationAccess) {
        await call('openSettings', { screen: 'notifications' });
        result = 'settings';
      }
    } else if (sense === 'calls') {
      const p = await call('requestPermissions', { permissions: ['calls', 'contacts'] });
      if (p.calls !== 'granted') return 'denied';
    } else if (sense === 'calendar') {
      const p = await call('requestPermissions', { permissions: ['calendar'] });
      if (p.calendar !== 'granted') return 'denied';
    } else if (sense === 'usage') {
      await refreshStatus();
      if (!status.usageAccess) {
        await call('openSettings', { screen: 'usage' });
        result = 'settings';
      }
    } else if (sense === 'health') {
      const h = await call('requestHealth');
      if (h.health === 'unsupported') return 'unsupported';
      if (h.health === 'install') result = 'install';
      else if (!Array.isArray(h.granted) || !h.granted.length) return 'denied';
    }
    return result;
  } catch {
    return 'error';
  }
}

// Turns one off. Arise stops reading it, forgets how far it had read, and gives back the
// permission where Android lets it. What's already in the life log stays there.
export async function turnOff(sense: Sense) {
  update((st) => {
    st.on[sense] = false;
    delete st.last[sense];
    if (sense === 'calls') delete st.calls;
    if (sense === 'usage') delete st.usage;
    if (sense === 'calendar') delete st.calendar;
    if (sense === 'health') {
      delete st.health;
      delete st.healthDay;
    }
  });
  if (!supported()) return;
  try {
    if (sense === 'notifications') await call('setNotifications', { on: false, text: false });
    else if (sense === 'calls' || sense === 'calendar' || sense === 'health') await call('forget', { what: sense });
  } catch {}
  await refreshStatus();
}

// Notifications with their text, or only who and when.
export async function setText(on: boolean) {
  const st = update((s) => {
    s.text = on;
  });
  if (supported() && st.on.notifications) await call('setNotifications', { on: true, text: on }).catch(() => {});
}

// Everything off and forgotten (Erase all data).
export async function forgetAll() {
  for (const s of SENSES) if (read().on[s]) await turnOff(s);
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// Opens one of the phone's own screens: 'notifications', 'usage', 'health' or 'app' (App info).
export const openSettings = (screen: 'notifications' | 'usage' | 'health' | 'app') => (supported() ? call('openSettings', { screen }).then(() => true, () => false) : Promise.resolve(false));

// ---------- reading

const floorHour = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

const denied = (err: unknown) => (err as { code?: string })?.code === 'denied';
const message = (err: unknown) => (err as Error)?.message || "Couldn't read it.";

let running: Promise<number> | null = null;

// Reads everything that's on and adds what's new to the life log. One read at a time: a call while
// one runs gets that one. Resolves with how many new events were added. Nothing without a life log
// to put it in (the read would wait for it for good).
export function collect(now = () => Date.now()): Promise<number> {
  if (!supported() || !hasLifeStore()) return Promise.resolve(0);
  if (!running) running = collectAll(now).finally(() => (running = null));
  return running;
}

async function collectAll(now: () => number): Promise<number> {
  const st = read();
  if (!SENSES.some((s) => st.on[s])) return 0;
  // The life log first: until it's there, everything waits on the phone.
  const store = await lifeStore();
  await refreshStatus();
  let total = 0;
  const note = (sense: Sense, added: number, error?: string) => {
    update((s) => {
      s.last[sense] = error ? { at: now(), added, error } : { at: now(), added };
    });
    total += added;
  };
  const add = (events: (LifeEvent | null)[]) => {
    const list = events.filter((e): e is LifeEvent => !!e);
    return list.length ? store.addEvents(list) : Promise.resolve(0);
  };

  for (const sense of SENSES) {
    const cur = read();
    // (Notifications already waiting are taken even if access was taken back since.)
    if (!cur.on[sense] || (sense !== 'notifications' && blocked(sense))) continue;
    try {
      if (sense === 'notifications') {
        // What waited while the app was closed, a batch at a time: added first, then let go.
        let added = 0;
        for (let i = 0; i < 20; i++) {
          const { items, last } = await call<{ items: unknown[]; last: number }>('readNotifications', { max: 500 });
          if (!Array.isArray(items) || !items.length || !(last > 0)) break;
          added += await add(items.map((n) => notificationEvent(n, cur.text)));
          await call('ackNotifications', { upTo: last });
        }
        note(sense, added);
      } else if (sense === 'calls') {
        const since = cur.calls ?? now() - BACK.calls;
        const { calls } = await call<{ calls: unknown[] }>('readCalls', { since, max: 2000 });
        const rows = Array.isArray(calls) ? calls : [];
        const added = await add(rows.map(callEvent));
        const latest = Math.max(since, ...rows.map((r) => time((r as Record<string, unknown>)?.date) || 0));
        update((s) => {
          s.calls = latest;
        });
        note(sense, added);
      } else if (sense === 'usage') {
        // Whole hours only, so an hour is never noted half-way through.
        const to = floorHour(now());
        const from = cur.usage ?? floorHour(now() - BACK.usage);
        if (to > from) {
          const { usage } = await call<{ usage: unknown[] }>('readUsage', { from, to });
          const added = await add((Array.isArray(usage) ? usage : []).map(usageEvent));
          update((s) => {
            s.usage = to;
          });
          note(sense, added);
        }
      } else if (sense === 'health') {
        // Steps and heart rate for whole days that ended at least half a day ago (a watch may sync
        // late), sleep and workouts up to now.
        const toDay = dayKey(now() - SETTLE);
        const fromDay = cur.healthDay ?? dayKey(now() - BACK.health);
        const from = cur.health ?? now() - BACK.health;
        const to = now();
        const { days, sessions } = await call<{ days: unknown[]; sessions: unknown[] }>('readHealth', { fromDay, toDay, from, to });
        const events = [...(Array.isArray(days) ? days : []).flatMap(healthDayEvents), ...(Array.isArray(sessions) ? sessions : []).map(healthSessionEvent)];
        const added = await add(events);
        update((s) => {
          if (toDay > fromDay) s.healthDay = toDay;
          // A session written a little late is still found next time.
          s.health = to - SETTLE;
        });
        note(sense, added);
      } else if (sense === 'calendar') {
        const to = now();
        const from = cur.calendar ? cur.calendar - CALENDAR_AGAIN : to - BACK.calendar;
        const { events } = await call<{ events: unknown[] }>('readCalendar', { from, to, max: 2000 });
        const added = await add((Array.isArray(events) ? events : []).map(calendarEvent));
        update((s) => {
          s.calendar = to;
        });
        note(sense, added);
      }
    } catch (err) {
      note(sense, 0, denied(err) ? "Android doesn't allow it any more." : message(err));
    }
  }
  await refreshStatus();
  return total;
}

// ---------- start

// Reads when the app opens and each time it comes back to the front (from the phone's settings,
// say). `changed` runs when there's something new to show. Not in a build without the life log:
// Settings leaves this out there, and nothing is read.
export function initAndroidSense(changed: () => void = () => {}) {
  if (!supported() || !hasLifeStore()) return;
  const go = () => {
    refreshStatus().then(changed, () => {});
    collect().then(changed, () => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  go();
}
