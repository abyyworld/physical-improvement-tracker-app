// What the iPhone app notices for the life log: Apple Health (and every watch, ring, scale or app
// that saves to it), motion, the calendar, places, and what Shortcuts automations send. In the
// iPhone app only: on the web and on a laptop nothing here runs.
//
// Each source is off until the Player turns it on (Settings, Your life, see sense-ui.ts), and
// turning one on asks iOS for permission right then. Arise reads them when it opens and each time
// it comes back to the front, picking up where the last read stopped (the first read of Apple
// Health goes back 2 years). What's read goes to the life log through lifeStore(), once it's ready.
//
// The native side is Arise's own Swift (ios/App/App/AriseSense.swift, AriseInbox.swift,
// LogToArise.swift) plus the Health plugin (@capgo/capacitor-health) for most of Health.

import { lifeStore, type LifeStore } from './store-port';
import type { LifeEvent } from './types';
import * as M from './sense-map';

export type Source = 'health' | 'motion' | 'calendar' | 'places' | 'shortcuts';
export const SOURCES: Source[] = ['health', 'motion', 'calendar', 'places', 'shortcuts'];

const KEY = 'arise-life-sense'; // this iPhone only: never synced
const BACKFILL = 730 * M.DAY; // Apple Health, the first time
const CALENDAR_BACK = 365 * M.DAY;
const MOTION_KEPT = 7 * M.DAY; // iOS keeps motion for 7 days
const AGAIN_AFTER = 2 * M.MIN; // coming back to Arise more often than this doesn't read again
const BATCH = 500;

interface Cap {
  isNativePlatform?: () => boolean;
  PluginHeaders?: { name: string }[];
  nativePromise: (plugin: string, method: string, options?: object) => Promise<Record<string, unknown>>;
}
const cap = () => (globalThis as { Capacitor?: Cap }).Capacitor;
const isNative = () => !!cap()?.isNativePlatform?.();
const has = (name: string) => isNative() && !!cap()?.PluginHeaders?.some((h) => h.name === name);
const call = (plugin: string, method: string, options: object = {}) => cap()!.nativePromise(plugin, method, options);
const sense = (method: string, options: object = {}) => call('AriseSense', method, options);

// The iPhone app, new enough to have Arise's own native code.
export const inIPhoneApp = isNative;
export const supported = () => has('AriseSense');

// ---------- what's kept on this iPhone

interface Last {
  at: number;
  added: number;
  error?: string;
}
export interface SenseState {
  on: Record<Source, boolean>;
  cursor: { days?: string; sleep?: number; workouts?: number; moods?: number; motion?: number; calendar?: number };
  last: Partial<Record<Source, Last>>;
  noHealth?: boolean; // Health said no: this copy of the app has no Health access (see HEALTH_BLOCKED)
  addWorkouts?: boolean; // put each workout finished in Arise in the iPhone's calendar
  held: M.InboxItem[]; // an app still open, a place not left yet
}

const fresh = (): SenseState => ({ on: { health: false, motion: false, calendar: false, places: false, shortcuts: true }, cursor: {}, last: {}, held: [] });
const okTime = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

export function cleanState(raw: unknown): SenseState {
  const st = fresh();
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const on = (o.on && typeof o.on === 'object' ? o.on : {}) as Record<string, unknown>;
  for (const s of SOURCES) if (typeof on[s] === 'boolean') st.on[s] = on[s] as boolean;
  const c = (o.cursor && typeof o.cursor === 'object' ? o.cursor : {}) as Record<string, unknown>;
  if (M.isDayKey(c.days)) st.cursor.days = c.days;
  for (const k of ['sleep', 'workouts', 'moods', 'motion', 'calendar'] as const) {
    const t = okTime(c[k]);
    if (t) st.cursor[k] = t;
  }
  const last = (o.last && typeof o.last === 'object' ? o.last : {}) as Record<string, unknown>;
  for (const s of SOURCES) {
    const l = last[s] as Record<string, unknown> | undefined;
    const at = okTime(l?.at);
    if (!at) continue;
    st.last[s] = { at, added: typeof l!.added === 'number' && l!.added >= 0 ? Math.round(l!.added) : 0 };
    if (typeof l!.error === 'string' && l!.error) st.last[s]!.error = l!.error.slice(0, 300);
  }
  if (o.noHealth === true) st.noHealth = true;
  if (o.addWorkouts === true) st.addWorkouts = true;
  st.held = M.list(o.held)
    .map(M.cleanItem)
    .filter((it): it is M.InboxItem => !!it)
    .slice(-500);
  return st;
}

let state: SenseState | null = null;
export function read(): SenseState {
  if (!state) {
    try {
      state = cleanState(JSON.parse(localStorage.getItem(KEY) || '{}'));
    } catch {
      state = fresh();
    }
  }
  return state;
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(read()));
  } catch {}
}

// ---------- what iOS says (for Settings)

export interface Status {
  busy: boolean;
  shortcuts?: boolean; // iOS 16 or later
  moods?: boolean; // iOS 18 or later
  motion?: string; // granted, denied, restricted, prompt, unavailable
  calendar?: string; // granted, writeOnly, denied, restricted, prompt
  places?: string; // always, whenInUse, denied, restricted, prompt
}
export const status: Status = { busy: false };

let changed: () => void = () => {};
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function refreshStatus() {
  if (!supported()) return;
  const get = async (method: string) => {
    try {
      return await sense(method);
    } catch {
      return {};
    }
  };
  const info = await get('info');
  status.shortcuts = info.shortcuts === true;
  status.moods = info.moods === true;
  status.motion = str((await get('motionStatus')).status);
  status.calendar = str((await get('calendarStatus')).status);
  status.places = str((await get('placesStatus')).status);
  changed();
}

// ---------- turning a source on and off

const message = (err: unknown) => String((err as { message?: string })?.message || err || 'Something went wrong.').slice(0, 300);
// Health refuses everything when the app wasn't signed with Health access (the entitlement).
const noEntitlement = (err: unknown) => /entitlement/i.test(message(err));

export const HEALTH_BLOCKED =
  "Apple Health isn't open to this copy of Arise. The app that installed it (Sideloadly or AltStore) left Health access out, which a free Apple ID sometimes does. Everything else still works.";

// Asks iOS for permission and turns the source on. The answer is something to tell the Player
// ('' when there's nothing to add).
export async function turnOn(src: Source): Promise<string> {
  if (!supported()) return '';
  const st = read();
  let note = '';
  try {
    if (src === 'health') {
      if (!has('Health')) return 'Apple Health needs the newest Arise.ipa.';
      await sense('healthAccess');
      st.noHealth = false;
      note = 'If nothing shows up, check what Arise may read: Health app, your picture, Apps, Arise.';
    } else if (src === 'motion') {
      const s = str((await sense('motionAccess')).status);
      status.motion = s;
      if (s !== 'granted') return s === 'unavailable' ? "This iPhone can't tell how you move." : 'Motion is off for Arise. Turn on Motion & Fitness for Arise in the Settings app.';
    } else if (src === 'calendar') {
      const s = str((await sense('calendarAccess')).status);
      status.calendar = s;
      if (s !== 'granted') return "Arise can't see your calendars. In the Settings app, open Arise, then Calendars, and choose Full Access.";
    } else if (src === 'places') {
      const s = str((await sense('placesStart')).status);
      status.places = s;
      if (s !== 'always' && s !== 'whenInUse') {
        await sense('placesStop').catch(() => {});
        return 'Location is off for Arise. In the Settings app, open Arise, then Location, and choose Always.';
      }
      if (s === 'whenInUse') note = "Places are noted only while Arise is open. To note them while it's closed, set Location to Always: Settings app, Arise, Location.";
    }
  } catch (err) {
    if (src === 'health' && noEntitlement(err)) {
      st.noHealth = true;
      save();
      changed();
      return HEALTH_BLOCKED;
    }
    return `That didn't work: ${message(err)}`;
  }
  st.on[src] = true;
  delete st.last[src];
  save();
  changed();
  collect(true);
  return note;
}

// Stops reading it. What was read stays in the life log. Turned on again, it reads from the start.
export async function turnOff(src: Source) {
  const st = read();
  st.on[src] = false;
  delete st.last[src];
  if (src === 'health') for (const k of ['days', 'sleep', 'workouts', 'moods'] as const) delete st.cursor[k];
  if (src === 'motion') delete st.cursor.motion;
  if (src === 'calendar') {
    delete st.cursor.calendar;
    st.addWorkouts = false;
  }
  if (src === 'places') st.held = st.held.filter((it) => it.type !== 'visit');
  if (src === 'shortcuts') st.held = st.held.filter((it) => it.type !== 'log');
  save();
  changed();
  if (src === 'places' && supported()) {
    try {
      status.places = str((await sense('placesStop')).status);
    } catch {}
  }
}

// ---------- workouts into the calendar

// Asks for the calendar first if it has to.
export async function setAddWorkouts(on: boolean): Promise<string> {
  const st = read();
  if (on && supported()) {
    try {
      const s = str((await sense('calendarAccess')).status);
      status.calendar = s;
      if (s !== 'granted' && s !== 'writeOnly') return "Arise can't add to your calendar. In the Settings app, open Arise, then Calendars, and choose Full Access.";
    } catch (err) {
      return `That didn't work: ${message(err)}`;
    }
  }
  st.addWorkouts = on && supported();
  save();
  changed();
  return '';
}

interface Finished {
  name?: string;
  started?: number;
  finished?: number;
}

// A workout was just finished in Arise. Arise leaves its own events out when it reads the
// calendar, so this doesn't come back into the life log twice.
export async function workoutDone(session: Finished | null) {
  if (!session || !supported() || !read().addWorkouts) return;
  const { started, finished } = session;
  if (typeof started !== 'number' || typeof finished !== 'number' || finished <= started) return;
  try {
    await sense('calendarAdd', { title: `Arise: ${session.name || 'Workout'}`, start: started, end: finished });
  } catch (err) {
    console.warn("Couldn't add the workout to the calendar", err);
  }
}

// Everything off, and nothing left waiting (when everything on this device is erased).
export async function forget() {
  state = fresh();
  try {
    localStorage.removeItem(KEY);
  } catch {}
  if (supported()) {
    await sense('placesStop').catch(() => {});
    await sense('inboxTake').catch(() => {});
    await sense('inboxClear').catch(() => {});
  }
  changed();
}

// ---------- reading

async function add(store: LifeStore, events: LifeEvent[]) {
  let added = 0;
  for (let i = 0; i < events.length; i += BATCH) added += await store.addEvents(events.slice(i, i + BATCH));
  return added;
}

const iso = (ms: number) => new Date(ms).toISOString();

// Health samples, a stretch of time at a time (sleep can be thousands of pieces). A piece that
// crosses from one stretch into the next comes back twice, so it's counted once.
async function healthSamples(dataType: string, from: number, to: number, stretch: number) {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (let s = from; s < to; s += stretch) {
    const r = await call('Health', 'readSamples', { dataType, startDate: iso(s), endDate: iso(Math.min(to, s + stretch)), limit: 20000, ascending: true });
    for (const x of M.list(r.samples)) {
      const o = x as Record<string, unknown>;
      const id = typeof o?.platformId === 'string' ? o.platformId : JSON.stringify([o?.startDate, o?.endDate, o?.value, o?.sleepState]);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(x);
    }
  }
  return out;
}

async function healthWorkouts(from: number, to: number) {
  const out: unknown[] = [];
  let anchor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await call('Health', 'queryWorkouts', { startDate: iso(from), endDate: iso(to), limit: 500, ascending: true, ...(anchor ? { anchor } : {}) });
    out.push(...M.list(r.workouts));
    anchor = typeof r.anchor === 'string' ? r.anchor : undefined;
    if (!anchor) break;
  }
  return out;
}

async function readHealth(store: LifeStore, st: SenseState, now: number) {
  if (!has('Health')) throw new Error('Apple Health needs the newest Arise.ipa.');
  let added = 0;
  // Workouts and sleep: the last week (sleep: 3 days) again too, for a watch or ring that synced late.
  const wFrom = Math.max(now - BACKFILL, (st.cursor.workouts ?? 0) - 7 * M.DAY);
  added += await add(store, M.workoutEvents(await healthWorkouts(wFrom, now)));
  st.cursor.workouts = now;
  save();

  // Sleep is read from a day earlier than that, so a night already in the life log isn't cut where
  // the read begins (its last hours would look like a nap). Only what begins after sFrom is added.
  const sFrom = Math.max(now - BACKFILL, (st.cursor.sleep ?? 0) - 3 * M.DAY);
  added += await add(store, M.sleepEvents(await healthSamples('sleep', sFrom - M.DAY, now, 30 * M.DAY), now, sFrom));
  st.cursor.sleep = now;
  save();

  // Daily totals, for the days that are over (see SETTLE_DAY).
  const through = M.settledThrough(now);
  const first = st.cursor.days ?? M.dayKey(now - BACKFILL);
  if (first <= through) {
    const start = M.dayStart(first);
    const end = M.dayStart(M.nextDay(through));
    const daily = async (dataType: string, aggregation: string) =>
      M.list((await call('Health', 'queryAggregated', { dataType, startDate: iso(start), endDate: iso(end), bucket: 'day', aggregation })).samples);
    const input: M.DayInput = {
      steps: await daily('steps', 'sum'),
      distance: await daily('distance', 'sum'),
      energy: await daily('calories', 'sum'),
      restingHr: await daily('restingHeartRate', 'average'),
      weight: await daily('weight', 'average'),
      hrv: await healthSamples('heartRateVariability', start, end, 120 * M.DAY),
      mindful: await healthSamples('mindfulness', start, end, 365 * M.DAY),
    };
    added += await add(store, M.dayEvents(input, first, through));
    st.cursor.days = M.nextDay(through);
    save();
  }

  if (status.moods) {
    const mFrom = Math.max(now - BACKFILL, (st.cursor.moods ?? 0) - 7 * M.DAY);
    added += await add(store, M.moodEvents(M.list((await sense('moods', { from: mFrom, to: now })).moods)));
    st.cursor.moods = now;
    save();
  }
  return added;
}

async function readMotion(store: LifeStore, st: SenseState, now: number) {
  const from = Math.max(now - MOTION_KEPT + 5 * M.MIN, st.cursor.motion ?? 0);
  const r = await sense('motion', { from, to: now });
  const until = typeof r.to === 'number' ? r.to : now;
  const { events, cursor } = M.motionTrips(M.motionEntries(M.list(r.activities)), until);
  const added = await add(store, events);
  st.cursor.motion = cursor ?? until;
  return added;
}

async function readCalendar(store: LifeStore, st: SenseState, now: number) {
  const from = Math.max(now - CALENDAR_BACK, (st.cursor.calendar ?? 0) - M.DAY);
  const r = await sense('calendarEvents', { from, to: now });
  const added = await add(store, M.calendarEvents(M.list(r.events), now));
  st.cursor.calendar = now;
  return added;
}

// The inbox: what Shortcuts automations sent and the places visited while Arise was closed. It's
// cleared only once the life log has it. Anything from a source that's off is dropped.
async function readInbox(store: LifeStore, st: SenseState, now: number) {
  const { text } = await sense('inboxTake');
  const items = M.parseInbox(typeof text === 'string' ? text : '').filter((it) => (it.type === 'log' ? st.on.shortcuts : st.on.places));
  const { events, visits, held } = M.sortInbox(items, st.held, now);
  const names = new Map<string, M.PlaceName>();
  for (const v of visits) {
    const near = `${v.lat.toFixed(3)},${v.lon.toFixed(3)}`;
    let place = names.get(near) ?? null;
    if (!place) {
      try {
        place = M.cleanPlace(await sense('placeName', { lat: v.lat, lon: v.lon }));
        names.set(near, place);
      } catch {
        // Offline, most likely: try again next time, for up to 3 days.
        if (now - (v.depart ?? v.arrive ?? now) < 3 * M.DAY) {
          held.push(v);
          continue;
        }
      }
    }
    events.push(M.visitEvent(v, place));
  }
  const added = await add(store, events);
  st.held = held.slice(-500);
  save();
  await sense('inboxClear');
  return added;
}

// Shortcuts and places come in through the inbox (readInbox).
const READERS = { motion: readMotion, calendar: readCalendar, health: readHealth };

let running: Promise<void> | null = null;
let again = false;

// Reads every source that's on. `force`: even if it was read a moment ago.
export function collect(force = false): Promise<void> {
  if (!supported()) return Promise.resolve();
  if (running) {
    if (force) again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        const f = force || again;
        again = false;
        await run(f);
      } while (again);
    } finally {
      running = null;
      status.busy = false;
      changed();
    }
  })();
  return running;
}

async function run(force: boolean) {
  const st = read();
  const store = await lifeStore();
  status.busy = true;
  changed();
  const now = Date.now();
  const due = (src: Source) => force || !st.last[src] || now - st.last[src]!.at >= AGAIN_AFTER;
  const note = (srcs: Source[], added: number, error?: string) => {
    for (const s of srcs) if (st.on[s]) st.last[s] = { at: now, added, ...(error ? { error } : {}) };
    save();
  };
  // The inbox is always emptied, so it can't grow while both its sources are off.
  if (force || due('shortcuts') || due('places')) {
    try {
      note(['shortcuts', 'places'], await readInbox(store, st, now));
    } catch (err) {
      note(['shortcuts', 'places'], 0, message(err));
    }
  }
  for (const src of ['motion', 'calendar', 'health'] as const) {
    if (!st.on[src] || !due(src)) continue;
    if (src === 'health' && st.noHealth) continue;
    try {
      note([src], await READERS[src](store, st, now));
    } catch (err) {
      if (src === 'health' && noEntitlement(err)) st.noHealth = true;
      note([src], 0, message(err));
    }
  }
}

// Arise's page in the Settings app, to change what it may use.
export async function openSettings() {
  if (supported()) await sense('openSettings').catch(() => {});
}

// In the iPhone app: read now, and every time Arise comes back to the front.
export function initSense(opts: { changed?: () => void } = {}) {
  if (!supported()) return;
  if (opts.changed) changed = opts.changed;
  refreshStatus().then(() => collect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // The Player may have changed what Arise may use in the Settings app.
    refreshStatus().then(() => collect());
  });
}
