// @vitest-environment jsdom
// The iPhone app's reading for the life log (sense.ts): permission asked when a source is turned
// on, reading from where the last read stopped, the inbox cleared only once the life log has
// it, and nothing at all on the web. The iPhone's plugins and the life log are simulated in memory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

type Opts = Record<string, unknown>;
type Handler = (o: Opts) => unknown;

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86400000;

function fakeIPhone(handlers: Record<string, Handler> = {}, plugins = ['AriseSense', 'Health']) {
  const calls: { method: string; options: Opts }[] = [];
  const all: Record<string, Handler> = {
    'AriseSense.info': () => ({ version: 1, health: true, motion: true, shortcuts: true, moods: true }),
    'AriseSense.motionStatus': () => ({ status: 'prompt' }),
    'AriseSense.calendarStatus': () => ({ status: 'prompt' }),
    'AriseSense.placesStatus': () => ({ status: 'prompt', on: false }),
    'AriseSense.inboxTake': () => ({ text: '' }),
    'AriseSense.inboxClear': () => ({}),
    ...handlers,
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Opts = {}) => {
      const key = `${plugin}.${method}`;
      calls.push({ method: key, options });
      const fn = all[key];
      if (!fn) throw new Error(`${key} isn't simulated`);
      return fn(options);
    },
  };
  const called = (method: string) => calls.filter((c) => c.method === method);
  return { calls, called };
}

function fakeLog() {
  const events = new Map<string, LifeEvent>();
  const store = {
    fail: false,
    async addEvents(list: LifeEvent[]) {
      if (store.fail) throw new Error('The life log is locked.');
      let added = 0;
      for (const e of list) {
        if (events.has(e.id)) continue;
        events.set(e.id, e);
        added++;
      }
      return added;
    },
  };
  return { events, store };
}

async function load({ log = true } = {}) {
  vi.resetModules();
  const port = await import('./store-port');
  const sense = await import('./sense');
  const fake = fakeLog();
  if (log) port.setLifeStore(fake.store);
  return { port, sense, ...fake };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

describe('on the web and on a laptop', () => {
  it('does nothing at all', async () => {
    const { sense, events } = await load();
    sense.initSense();
    await sense.collect(true);
    expect(await sense.turnOn('health')).toBe('');
    expect(sense.supported()).toBe(false);
    expect(sense.read().on.health).toBe(false);
    expect(events.size).toBe(0);
    expect(localStorage.getItem('arise-life-sense')).toBeNull();
  });

  it('does nothing in an older iPhone app without the native part', async () => {
    const phone = fakeIPhone({}, ['Filesystem']);
    const { sense } = await load();
    sense.initSense();
    await sense.collect(true);
    expect(sense.supported()).toBe(false);
    expect(phone.calls).toEqual([]);
  });
});

describe('Apple Health', () => {
  const workout = { workoutType: 'running', duration: 1800, totalDistance: 5000, startDate: iso(at(16, 7)), endDate: iso(at(16, 7, 30)), platformId: 'W1' };
  const sleep = [
    { startDate: iso(at(16, 23)), endDate: iso(at(17, 3)), value: 240, sleepState: 'light', sourceId: 'watch', platformId: 'S1' },
    { startDate: iso(at(17, 3)), endDate: iso(at(17, 7)), value: 240, sleepState: 'deep', sourceId: 'watch', platformId: 'S2' },
  ];
  const health = (extra: Record<string, Handler> = {}) =>
    fakeIPhone({
      'AriseSense.healthAccess': () => ({ asked: true }),
      'AriseSense.moods': () => ({ moods: [{ id: 'M1', at: at(16, 9), kind: 1, valence: 0.5, feeling: 6, labels: [17], about: [] }] }),
      'Health.queryWorkouts': () => ({ workouts: [workout] }),
      'Health.readSamples': (o) => ({ samples: o.dataType === 'sleep' ? sleep : o.dataType === 'heartRateVariability' ? [{ startDate: iso(at(16, 3)), endDate: iso(at(16, 3)), value: 48, platformId: 'H1' }] : [] }),
      'Health.queryAggregated': (o) => ({ samples: o.dataType === 'steps' ? [{ startDate: iso(at(16)), endDate: iso(at(17)), value: 9000 }] : [] }),
      ...extra,
    });

  it('asks once when turned on, then reads the last 2 years into the life log', async () => {
    const phone = health();
    const { sense, events } = await load();
    await sense.refreshStatus();
    expect(await sense.turnOn('health')).toMatch(/Health app/);
    await sense.collect();
    expect(phone.called('AriseSense.healthAccess')).toHaveLength(1);
    expect([...events.keys()].sort()).toEqual(['health:body:2026-10-16', 'health:day:2026-10-16', 'health:mood:M1', 'health:sleep:2026-10-17', 'health:workout:W1']);
    expect(events.get('health:sleep:2026-10-17')).toMatchObject({ title: 'Slept 8 h', tier: 2 });
    expect(events.get('health:body:2026-10-16')).toMatchObject({ title: 'HRV 48 ms', tier: 3 });
    // The first read goes back 2 years.
    expect(phone.called('Health.queryWorkouts')[0].options.startDate).toBe(iso(NOW - 730 * DAY));
    // Sleep from a day before that, so a night isn't cut where the read begins.
    expect(phone.called('Health.readSamples')[0].options).toMatchObject({ dataType: 'sleep', startDate: iso(NOW - 731 * DAY) });
    const st = sense.read();
    expect(st.on.health).toBe(true);
    expect(st.cursor.days).toBe('2026-10-17'); // today isn't over: it's read tomorrow
    expect(st.last.health).toEqual({ at: NOW, added: 5 });
    expect(JSON.parse(localStorage.getItem('arise-life-sense')!).on.health).toBe(true);
  });

  it('then reads only what is new (with a week again, for late syncs)', async () => {
    const phone = health();
    const { sense, events } = await load();
    await sense.refreshStatus();
    await sense.turnOn('health');
    await sense.collect();
    phone.calls.length = 0;
    vi.setSystemTime(NOW + 3600000);
    await sense.collect(true);
    expect(phone.called('Health.queryWorkouts')[0].options.startDate).toBe(iso(NOW - 7 * DAY));
    expect(phone.called('Health.readSamples')[0].options.startDate).toBe(iso(NOW - 3 * DAY - DAY)); // sleep: 3 days, read from a day before
    expect(phone.called('Health.queryAggregated')).toEqual([]); // today isn't settled yet
    expect(events.size).toBe(5);
    expect(sense.read().last.health).toEqual({ at: NOW + 3600000, added: 0 });
  });

  it("doesn't take the last hours of a night already logged for a nap when a read begins in them", async () => {
    // Like Health: only the pieces that overlap what was asked for.
    const night = [
      { startDate: iso(at(16, 23)), endDate: iso(at(17, 3)), value: 240, sleepState: 'light', sourceId: 'watch', platformId: 'N1' },
      { startDate: iso(at(17, 3)), endDate: iso(at(17, 7)), value: 240, sleepState: 'deep', sourceId: 'watch', platformId: 'N2' },
      { startDate: iso(at(17, 7)), endDate: iso(at(17, 8)), value: 60, sleepState: 'light', sourceId: 'watch', platformId: 'N3' },
    ];
    health({
      'Health.readSamples': (o) => ({
        samples: o.dataType === 'sleep' ? night.filter((p) => Date.parse(p.endDate) > Date.parse(o.startDate as string) && Date.parse(p.startDate) < Date.parse(o.endDate as string)) : [],
      }),
    });
    const { sense, events } = await load();
    await sense.turnOn('health');
    await sense.collect();
    expect(events.get('health:sleep:2026-10-17')).toMatchObject({ title: 'Slept 9 h' });
    // Opened at 7:10 three days later, then again: that read's 3 days begin at 7:10 on the 17th.
    vi.setSystemTime(at(20, 7, 10));
    await sense.collect(true);
    vi.setSystemTime(at(20, 9));
    await sense.collect(true);
    expect([...events.keys()].filter((k) => k.startsWith('health:sleep:') || k.startsWith('health:nap:'))).toEqual(['health:sleep:2026-10-17']);
  });

  it('keeps going back 2 years until Health gives something (it gives nothing for what Arise may not read)', async () => {
    let allowed = false;
    const phone = health({
      'AriseSense.moods': () => ({ moods: allowed ? [{ id: 'M1', at: at(16, 9), kind: 1, valence: 0.5, feeling: 6, labels: [17], about: [] }] : [] }),
      'Health.queryWorkouts': () => ({ workouts: allowed ? [workout] : [] }),
      'Health.readSamples': (o) => ({ samples: allowed && o.dataType === 'sleep' ? sleep : [] }),
      'Health.queryAggregated': (o) => ({ samples: allowed && o.dataType === 'steps' ? [{ startDate: iso(at(16)), endDate: iso(at(17)), value: 9000 }] : [] }),
    });
    const { sense, events } = await load();
    await sense.refreshStatus();
    await sense.turnOn('health');
    await sense.collect();
    expect(events.size).toBe(0);
    expect(sense.read().cursor).toEqual({});
    // A week later, the Player allows it in the Health app.
    allowed = true;
    phone.calls.length = 0;
    const later = NOW + 7 * DAY;
    vi.setSystemTime(later);
    await sense.collect(true);
    expect(phone.called('Health.queryWorkouts')[0].options.startDate).toBe(iso(later - 730 * DAY));
    expect(phone.called('Health.readSamples')[0].options).toMatchObject({ dataType: 'sleep', startDate: iso(later - 731 * DAY) });
    expect(phone.called('Health.queryAggregated')[0].options.startDate).toBe(iso(new Date(2024, 9, 24).getTime()));
    expect(phone.called('AriseSense.moods')[0].options.from).toBe(later - 730 * DAY);
    expect([...events.keys()].sort()).toEqual(['health:day:2026-10-16', 'health:mood:M1', 'health:sleep:2026-10-17', 'health:workout:W1']);
    expect(sense.read().cursor).toEqual({ workouts: later, sleep: later, days: '2026-10-24', moods: later });
    // From then on it goes on from there, even when there's nothing new.
    allowed = false;
    phone.calls.length = 0;
    vi.setSystemTime(later + DAY);
    await sense.collect(true);
    expect(phone.called('Health.queryWorkouts')[0].options.startDate).toBe(iso(later - 7 * DAY));
    expect(sense.read().cursor).toEqual({ workouts: later + DAY, sleep: later + DAY, days: '2026-10-25', moods: later + DAY });
  });

  it("says so and stays off when this copy of the app has no Health access", async () => {
    const phone = health({
      'AriseSense.healthAccess': () => {
        throw new Error('Missing com.apple.developer.healthkit entitlement.');
      },
    });
    const { sense } = await load();
    expect(await sense.turnOn('health')).toBe(sense.HEALTH_BLOCKED);
    await sense.collect(true);
    expect(sense.read().on.health).toBe(false);
    expect(sense.read().noHealth).toBe(true);
    expect(phone.calls.filter((c) => c.method.startsWith('Health.'))).toEqual([]);
  });

  it('keeps its place when a read fails, and says what went wrong', async () => {
    health({
      'Health.readSamples': () => {
        throw new Error('Protected health data is inaccessible');
      },
    });
    const { sense, events } = await load();
    await sense.turnOn('health');
    await sense.collect();
    const st = sense.read();
    expect(events.has('health:workout:W1')).toBe(true);
    expect(st.cursor.workouts).toBe(NOW);
    expect(st.cursor.sleep).toBeUndefined();
    expect(st.last.health?.error).toBe('Protected health data is inaccessible');
  });

  it('skips moods before iOS 18', async () => {
    const phone = health({ 'AriseSense.info': () => ({ shortcuts: true, moods: false }) });
    const { sense, events } = await load();
    await sense.refreshStatus();
    await sense.turnOn('health');
    await sense.collect();
    expect(phone.called('AriseSense.moods')).toEqual([]);
    expect(events.has('health:mood:M1')).toBe(false);
  });
});

describe('motion and the calendar', () => {
  it("stays off when motion isn't allowed", async () => {
    const phone = fakeIPhone({ 'AriseSense.motionAccess': () => ({ status: 'denied' }) });
    const { sense } = await load();
    expect(await sense.turnOn('motion')).toMatch(/Motion & Fitness/);
    expect(sense.read().on.motion).toBe(false);
    expect(phone.called('AriseSense.motion')).toEqual([]);
  });

  it('reads the last 7 days of motion, then goes on from the trip that was still going', async () => {
    const phone = fakeIPhone({
      'AriseSense.motionAccess': () => ({ status: 'granted' }),
      'AriseSense.motion': (o) => ({
        to: o.to,
        activities: [
          { t: at(17, 8), k: 'walk', c: 2 },
          { t: at(17, 8, 30), k: 'still', c: 2 },
          { t: at(17, 14), k: 'drive', c: 2 },
        ],
      }),
    });
    const { sense, events } = await load();
    expect(await sense.turnOn('motion')).toBe('');
    await sense.collect();
    expect(phone.called('AriseSense.motion')[0].options).toEqual({ from: NOW - 7 * DAY + 5 * 60000, to: NOW });
    expect([...events.values()].map((e) => e.title)).toEqual(['Walked 30 min']);
    expect(sense.read().cursor.motion).toBe(at(17, 14));
    await sense.collect(true);
    expect(phone.called('AriseSense.motion')[1].options.from).toBe(at(17, 14));
  });

  it('reads the past year of the calendar, then what is new', async () => {
    const phone = fakeIPhone({
      'AriseSense.calendarAccess': () => ({ status: 'granted' }),
      'AriseSense.calendarEvents': () => ({ events: [{ id: 'E1', title: 'Dentist', start: at(16, 9), end: at(16, 10), type: 1 }] }),
    });
    const { sense, events } = await load();
    await sense.turnOn('calendar');
    await sense.collect();
    expect(phone.called('AriseSense.calendarEvents')[0].options).toEqual({ from: NOW - 365 * DAY, to: NOW });
    expect([...events.keys()]).toEqual([`calendar:E1:${Math.round(at(16, 9) / 60000)}`]);
    vi.setSystemTime(NOW + DAY);
    await sense.collect(true);
    expect(phone.called('AriseSense.calendarEvents')[1].options.from).toBe(NOW - DAY);
  });

  it('puts a finished workout in the calendar, only when asked to', async () => {
    let access = 'denied';
    const phone = fakeIPhone({ 'AriseSense.calendarAccess': () => ({ status: access }), 'AriseSense.calendarAdd': () => ({ id: 'X' }) });
    const { sense } = await load();
    const workout = { name: 'Upper A', started: at(17, 7), finished: at(17, 7, 45) };
    await sense.workoutDone(workout);
    expect(await sense.setAddWorkouts(true)).toMatch(/Full Access/);
    await sense.workoutDone(workout);
    expect(phone.called('AriseSense.calendarAdd')).toEqual([]);
    access = 'writeOnly';
    expect(await sense.setAddWorkouts(true)).toBe('');
    await sense.workoutDone(workout);
    await sense.workoutDone(null);
    expect(phone.called('AriseSense.calendarAdd').map((c) => c.options)).toEqual([{ title: 'Arise: Upper A', start: at(17, 7), end: at(17, 7, 45) }]);
    await sense.turnOff('calendar');
    expect(sense.read().addWorkouts).toBe(false);
  });

  it("stays off when the calendar isn't allowed", async () => {
    fakeIPhone({ 'AriseSense.calendarAccess': () => ({ status: 'denied' }) });
    const { sense } = await load();
    expect(await sense.turnOn('calendar')).toMatch(/Full Access/);
    expect(sense.read().on.calendar).toBe(false);
  });
});

describe('places', () => {
  const visit = (id: string, arrive: number, depart?: number) => JSON.stringify({ type: 'visit', id, lat: 51.5, lon: -0.12, arrive, ...(depart ? { depart } : {}) });

  it('asks for location, says when Always would be better, and stops when turned off', async () => {
    const phone = fakeIPhone({
      'AriseSense.placesStart': () => ({ status: 'whenInUse', on: true }),
      'AriseSense.placesStop': () => ({ status: 'whenInUse', on: false }),
    });
    const { sense } = await load();
    expect(await sense.turnOn('places')).toMatch(/Always/);
    expect(sense.read().on.places).toBe(true);
    await sense.turnOff('places');
    expect(sense.read().on.places).toBe(false);
    expect(phone.called('AriseSense.placesStop')).toHaveLength(1);
  });

  it("stays off when location isn't allowed", async () => {
    const phone = fakeIPhone({
      'AriseSense.placesStart': () => ({ status: 'denied', on: true }),
      'AriseSense.placesStop': () => ({ status: 'denied', on: false }),
    });
    const { sense } = await load();
    expect(await sense.turnOn('places')).toMatch(/Location is off/);
    expect(sense.read().on.places).toBe(false);
    expect(phone.called('AriseSense.placesStop')).toHaveLength(1);
  });

  it('names the places visited while Arise was closed, or waits until it can', async () => {
    let online = false;
    const phone = fakeIPhone({
      'AriseSense.placesStart': () => ({ status: 'always', on: true }),
      'AriseSense.inboxTake': () => ({ text: `${visit('V1', at(17, 9), at(17, 10))}\n` }),
      'AriseSense.placeName': () => {
        if (!online) throw new Error('The operation couldn’t be completed. (kCLErrorDomain error 2.)');
        return { name: 'Gym One', city: 'London' };
      },
    });
    const { sense, events } = await load();
    await sense.turnOn('places');
    await sense.collect();
    expect(events.size).toBe(0);
    expect(sense.read().held.map((it) => it.id)).toEqual(['V1']);
    expect(phone.called('AriseSense.inboxClear')).toHaveLength(1); // it's kept here instead
    online = true;
    await sense.collect(true);
    expect([...events.values()].map((e) => [e.title, e.tier])).toEqual([['At Gym One', 3]]);
    expect(sense.read().held).toEqual([]);
  });
});

describe('the Shortcuts inbox', () => {
  const line = (id: string, kind: string, what: string, t = at(17, 9)) => JSON.stringify({ type: 'log', id, at: t, kind, what, detail: '' });

  it('adds what automations sent, then clears the inbox', async () => {
    const phone = fakeIPhone({ 'AriseSense.inboxTake': () => ({ text: [line('A1', 'arrived', 'Home'), 'garbage', line('A2', 'charging', 'Plugged in')].join('\n') }) });
    const { sense, events } = await load();
    await sense.collect(true);
    expect([...events.values()].map((e) => e.title)).toEqual(['Arrived at Home', 'Charger: Plugged in']);
    const take = phone.calls.findIndex((c) => c.method === 'AriseSense.inboxTake');
    const clear = phone.calls.findIndex((c) => c.method === 'AriseSense.inboxClear');
    expect(take).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(take);
    expect(sense.read().last.shortcuts).toEqual({ at: NOW, added: 2 });
  });

  it("keeps the inbox when the life log can't take it", async () => {
    const phone = fakeIPhone({ 'AriseSense.inboxTake': () => ({ text: line('A1', 'arrived', 'Home') }) });
    const { sense, store } = await load();
    store.fail = true;
    await sense.collect(true);
    expect(phone.called('AriseSense.inboxClear')).toEqual([]);
    expect(sense.read().last.shortcuts?.error).toBe('The life log is locked.');
  });

  it('drops what automations send while Shortcuts is off', async () => {
    const phone = fakeIPhone({ 'AriseSense.inboxTake': () => ({ text: line('A1', 'message', 'Hi') }) });
    const { sense, events } = await load();
    await sense.turnOff('shortcuts');
    await sense.collect(true);
    expect(events.size).toBe(0);
    expect(phone.called('AriseSense.inboxClear')).toHaveLength(1);
  });

  it('pairs an app opened before with it closing now', async () => {
    let text = line('O1', 'appOpened', 'Instagram', at(17, 14, 30));
    fakeIPhone({ 'AriseSense.inboxTake': () => ({ text }) });
    const { sense, events } = await load();
    await sense.collect(true);
    expect(events.size).toBe(0);
    text = line('C1', 'appClosed', 'Instagram', at(17, 14, 50));
    await sense.collect(true);
    expect([...events.values()].map((e) => e.title)).toEqual(['Used Instagram for 20 min']);
  });

  it('reads nothing and asks iOS nothing while this build has no life log', async () => {
    const phone = fakeIPhone({ 'AriseSense.inboxTake': () => ({ text: line('A1', 'arrived', 'Home') }) });
    const { sense, port } = await load({ log: false });
    expect(port.hasLifeStore()).toBe(false);
    sense.initSense();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 5));
    expect(phone.calls).toEqual([]);
    port.setLifeStore(fakeLog().store);
    expect(port.hasLifeStore()).toBe(true);
  });

  it('waits for the life log before taking anything', async () => {
    const phone = fakeIPhone({ 'AriseSense.inboxTake': () => ({ text: line('A1', 'arrived', 'Home') }) });
    const { sense, port, store, events } = await load({ log: false });
    const done = sense.collect(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(phone.called('AriseSense.inboxTake')).toEqual([]);
    port.setLifeStore(store);
    await done;
    expect(events.size).toBe(1);
  });
});

describe('erasing this device', () => {
  it('turns everything off, stops places and empties the inbox', async () => {
    const phone = fakeIPhone({
      'AriseSense.placesStart': () => ({ status: 'always', on: true }),
      'AriseSense.placesStop': () => ({ status: 'always', on: false }),
    });
    const { sense } = await load();
    await sense.turnOn('places');
    await sense.collect();
    phone.calls.length = 0;
    await sense.forget();
    expect(phone.calls.map((c) => c.method)).toEqual(['AriseSense.placesStop', 'AriseSense.inboxTake', 'AriseSense.inboxClear']);
    expect(sense.read().on).toEqual({ health: false, motion: false, calendar: false, places: false, shortcuts: true });
    expect(localStorage.getItem('arise-life-sense')).toBeNull();
  });
});

describe('the native parts this web app needs', () => {
  it('names the Health plugin and Arise\'s own Swift code, so an older Arise.ipa is told to update instead', () => {
    // See vite.config.ts (OWN_NATIVE) and native-update.ts (check: needsInstall).
    expect(__APP_NATIVE__.split(',')).toEqual(expect.arrayContaining(['@capgo/capacitor-health@8.11', 'arise-ios@1']));
  });
});

describe('what is kept on this iPhone', () => {
  it('keeps only what it understands', async () => {
    const { sense } = await load();
    expect(sense.cleanState('nonsense')).toEqual(sense.cleanState({}));
    const st = sense.cleanState({
      on: { health: true, motion: 'yes', shortcuts: false },
      cursor: { days: '2026-10-17', sleep: 5, motion: -1, calendar: 'soon' },
      last: { health: { at: 9, added: 3.4, error: 'x' }, motion: { at: 'then' } },
      noHealth: 1,
      held: [{ type: 'log', id: 'A1', at: 5, kind: 'appOpened', what: 'Maps' }, { type: 'log', id: '<script>' }],
    });
    expect(st).toEqual({
      on: { health: true, motion: false, calendar: false, places: false, shortcuts: false },
      cursor: { days: '2026-10-17', sleep: 5 },
      last: { health: { at: 9, added: 3, error: 'x' } },
      held: [{ type: 'log', id: 'A1', at: 5, kind: 'appOpened', what: 'Maps', detail: '' }],
    });
  });
});
