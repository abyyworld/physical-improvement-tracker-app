// @vitest-environment jsdom
// Your life, Android (android-sense.ts and its Settings panel, android-ui.ts): turning what the
// phone reads into life events with stable ids and the right tiers, missed calls, Android's
// permissions, and handing over the notifications that waited while the app was closed. Arise's
// Android plugin is simulated in memory, as is the life log (through store-port.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

type Options = Record<string, unknown>;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// The life log's own rule for ids (lib/validate.ts on its branch).
const LIFE_ID = /^[a-z]{2,12}:[\x21-\x7e]{1,240}$/;

interface Phone {
  sdk: number;
  notificationAccess: boolean;
  usageAccess: boolean;
  health: 'available' | 'install' | 'unsupported';
  healthGranted: string[];
  healthAnswer: string[]; // what Health Connect's screen allows
  perms: Record<string, string>; // calls, contacts, calendar
  answer: Record<string, string>; // what the Player says when Android asks
  queue: Options[];
  seq: number;
  calls: Options[];
  usage: Options[];
  calendar: Options[];
  days: Options[];
  sessions: Options[];
  log: { method: string; options: Options }[];
  fail: Record<string, { message: string; code?: string }>;
  notificationsOn: boolean;
  text: boolean;
}

function fakePhone(platform = 'android', plugins = ['AriseLife', 'Filesystem', 'WebView']) {
  const p: Phone = {
    sdk: 35,
    notificationAccess: false,
    usageAccess: false,
    health: 'available',
    healthGranted: [],
    healthAnswer: ['steps', 'sleep', 'exercise', 'heart'],
    perms: { calls: 'prompt', contacts: 'prompt', calendar: 'prompt' },
    answer: { calls: 'granted', contacts: 'granted', calendar: 'granted' },
    queue: [],
    seq: 0,
    calls: [],
    usage: [],
    calendar: [],
    days: [],
    sessions: [],
    log: [],
    fail: {},
    notificationsOn: false,
    text: false,
  };
  const handlers: Record<string, (o: Options) => unknown> = {
    status: () => ({ sdk: p.sdk, notificationAccess: p.notificationAccess, notificationsOn: p.notificationsOn, queued: p.queue.length, usageAccess: p.usageAccess, health: p.health, healthGranted: p.healthGranted }),
    checkPermissions: () => ({ ...p.perms }),
    requestPermissions: (o) => {
      for (const a of o.permissions as string[]) p.perms[a] = p.answer[a];
      return { ...p.perms };
    },
    setNotifications: (o) => {
      p.notificationsOn = o.on === true;
      p.text = o.text === true;
      if (!p.notificationsOn) p.queue = [];
    },
    readNotifications: (o) => {
      const items = p.queue.slice(0, Number(o.max));
      return { items, last: items.length ? Number(items[items.length - 1].seq) : 0 };
    },
    ackNotifications: (o) => {
      p.queue = p.queue.filter((n) => Number(n.seq) > Number(o.upTo));
    },
    readCalls: (o) => ({ calls: p.calls.filter((c) => Number(c.date) >= Number(o.since)).slice(0, Number(o.max)) }),
    readUsage: (o) => ({ usage: p.usage.filter((u) => Number(u.hour) >= Number(o.from) && Number(u.hour) < Number(o.to)) }),
    readCalendar: (o) => ({ events: p.calendar.filter((e) => Number(e.begin) >= Number(o.from) && Number(e.begin) < Number(o.to)) }),
    requestHealth: () => {
      if (p.health !== 'available') return { health: p.health, granted: [] };
      p.healthGranted = [...p.healthAnswer];
      return { health: 'available', granted: p.healthGranted };
    },
    readHealth: (o) => ({ days: p.days.filter((d) => String(d.day) >= String(o.fromDay) && String(d.day) < String(o.toDay)), sessions: p.sessions }),
    forget: (o) => {
      if (o.what === 'health') p.healthGranted = [];
    },
    openSettings: () => ({}),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => platform !== 'web',
    getPlatform: () => platform,
    PluginHeaders: plugins.map((name) => ({ name })),
    nativePromise: async (plugin: string, method: string, options: Options = {}) => {
      if (plugin !== 'AriseLife') throw new Error(`${plugin} isn't simulated`);
      p.log.push({ method, options });
      const f = p.fail[method];
      if (f) throw Object.assign(new Error(f.message), { code: f.code });
      const fn = handlers[method];
      if (!fn) throw new Error(`${method} isn't simulated`);
      return fn(options);
    },
  };
  return p;
}

// The life log: keeps each id once, like the real one.
function fakeLog() {
  const events = new Map<string, LifeEvent>();
  const log = {
    events,
    broken: false,
    async addEvents(list: LifeEvent[]) {
      if (log.broken) throw new Error('The life log is closed.');
      let n = 0;
      for (const e of list) {
        if (events.has(e.id)) continue;
        events.set(e.id, e);
        n++;
      }
      return n;
    },
  };
  return log;
}

let lifeLog = fakeLog();

async function load() {
  vi.resetModules();
  const port = await import('./store-port');
  port.setLifeStore(lifeLog);
  return import('./android-sense');
}

const queued = (p: Phone, n: Options) => p.queue.push({ ...n, seq: ++p.seq });

beforeEach(() => {
  localStorage.clear();
  lifeLog = fakeLog();
});
afterEach(() => {
  (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
});

describe('notifications as life events', () => {
  it('notes which app, who and when, and the text only when the Player asked for it', async () => {
    const A = await load();
    const raw = { key: '0|com.whatsapp|1|abc|10123', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Mum', text: 'Call me when you can', at: Date.UTC(2026, 9, 16, 9, 30) };
    const short = A.notificationEvent(raw, false)!;
    expect(short).toMatchObject({ source: 'other', kind: 'notification', at: raw.at, title: 'WhatsApp: Mum', tier: 3, meta: { device: 'android', app: 'WhatsApp', pkg: 'com.whatsapp' } });
    expect(short.detail).toBeUndefined();
    expect(JSON.stringify(short)).not.toContain('Call me');
    const full = A.notificationEvent(raw, true)!;
    expect(full.detail).toBe('Call me when you can');
    // The same notification always gets the same id, text or not.
    expect(full.id).toBe(short.id);
    expect(short.id).toMatch(LIFE_ID);
    expect(short.id.startsWith('other:android-note:')).toBe(true);
    expect(A.notificationEvent({ ...raw, at: raw.at + 1 }, false)!.id).not.toBe(short.id);
    expect(A.notificationEvent({ ...raw, key: 'other' }, false)!.id).not.toBe(short.id);
  });

  it("skips what isn't a notification it can describe", async () => {
    const A = await load();
    expect(A.notificationEvent({ pkg: 'com.x', at: 1e12 }, false)).toBeNull(); // nobody, no text
    expect(A.notificationEvent({ pkg: 'com.x', at: 1e12, text: 'hi' }, false)).toBeNull(); // only text, which is off
    expect(A.notificationEvent({ pkg: 'com.x', at: 1e12, text: 'hi' }, true)?.title).toBe('com.x');
    expect(A.notificationEvent({ title: 'Mum', at: 1e12 }, false)).toBeNull();
    expect(A.notificationEvent({ pkg: 'com.x', title: 'Mum' }, false)).toBeNull();
    expect(A.notificationEvent(null, false)).toBeNull();
  });
});

describe('calls as life events', () => {
  const at = Date.UTC(2026, 9, 16, 18, 5);
  const row = (type: number, extra: Options = {}) => ({ id: 41, number: '+44 7700 900123', name: 'Mum', type, date: at, duration: 0, presentation: 1, ...extra });

  it('says which calls were missed, declined or blocked', async () => {
    const A = await load();
    const missed = A.callEvent(row(A.CALL.missed))!;
    expect(missed).toMatchObject({ id: `other:android-call:${at}-41`, source: 'other', kind: 'call', at, title: 'Missed call from Mum', tier: 3, meta: { device: 'android', direction: 'in', missed: true, name: 'Mum', number: '+44 7700 900123' } });
    expect(missed.end).toBeUndefined();
    expect(missed.id).toMatch(LIFE_ID);
    expect(A.callEvent(row(A.CALL.rejected))).toMatchObject({ title: 'Declined a call from Mum', meta: { missed: true } });
    expect(A.callEvent(row(A.CALL.blocked))).toMatchObject({ title: 'Blocked a call from Mum', meta: { missed: true } });
    expect(A.callEvent(row(A.CALL.voicemail))).toMatchObject({ title: 'Voicemail from Mum', meta: { missed: true } });
  });

  it('notes how long answered and made calls lasted', async () => {
    const A = await load();
    const answered = A.callEvent(row(A.CALL.incoming, { duration: 312 }))!;
    expect(answered).toMatchObject({ title: 'Call from Mum (5 min)', end: at + 312_000, value: 312, unit: 's', meta: { direction: 'in', missed: false } });
    expect(A.callEvent(row(A.CALL.outgoing, { duration: 3720 }))).toMatchObject({ title: 'Called Mum (1 h 2 min)', meta: { direction: 'out', missed: false } });
    expect(A.callEvent(row(A.CALL.outgoing))).toMatchObject({ title: 'Called Mum (no answer)', meta: { direction: 'out', missed: false } });
    expect(A.callEvent(row(A.CALL.elsewhere))).toMatchObject({ title: 'Call from Mum, answered on another device', meta: { missed: false } });
  });

  it("names the caller from the contacts, or the number, or says it's private or unknown", async () => {
    const A = await load();
    expect(A.callEvent(row(A.CALL.missed, { name: '' }))!.title).toBe('Missed call from +44 7700 900123');
    expect(A.callEvent(row(A.CALL.missed, { name: '', number: '', presentation: 2 }))!.title).toBe('Missed call from a private number');
    expect(A.callEvent(row(A.CALL.missed, { name: '', number: '-1', presentation: 3 }))).toMatchObject({ title: 'Missed call from an unknown number' });
    expect(A.callEvent(row(A.CALL.missed, { name: '', number: '-1', presentation: 3 }))!.meta!.number).toBeUndefined();
  });

  it('skips rows it does not understand', async () => {
    const A = await load();
    expect(A.callEvent(row(99))).toBeNull();
    expect(A.callEvent({ ...row(1), id: 'x' })).toBeNull();
    expect(A.callEvent({ ...row(1), date: 0 })).toBeNull();
  });
});

describe('app use, health and calendar as life events', () => {
  it('notes time in an app per hour, from a minute up (tier 2)', async () => {
    const A = await load();
    const hour = new Date(2026, 9, 16, 21).getTime();
    expect(A.usageEvent({ pkg: 'com.instagram.android', app: 'Instagram', hour, ms: 23 * MIN })).toEqual({
      id: `other:android-app:com.instagram.android:${hour}`,
      source: 'other',
      kind: 'app',
      at: hour,
      title: 'Used Instagram for 23 min',
      value: 23,
      unit: 'min',
      tier: 2,
      meta: { device: 'android', app: 'Instagram', pkg: 'com.instagram.android' },
    });
    expect(A.usageEvent({ pkg: 'com.x', hour, ms: 40_000 })).toBeNull();
    expect(A.usageEvent({ pkg: 'com.x', hour, ms: 3 * HOUR })).toBeNull();
  });

  it('notes steps (tier 2) and heart rate (tier 3) for a whole day', async () => {
    const A = await load();
    const [steps, heart] = A.healthDayEvents({ day: '2026-10-16', steps: 8214, hrMin: 52, hrAvg: 71.6, hrMax: 141 });
    const midnight = new Date(2026, 9, 16).getTime();
    expect(steps).toMatchObject({ id: 'health:hc-steps:2026-10-16', source: 'health', kind: 'steps', at: midnight, end: new Date(2026, 9, 17).getTime(), title: '8,214 steps', value: 8214, unit: 'steps', tier: 2 });
    expect(heart).toMatchObject({ id: 'health:hc-heart:2026-10-16', kind: 'health', title: 'Heart rate 52 to 141, 72 on average', value: 72, unit: 'bpm', tier: 3 });
    expect(A.healthDayEvents({ day: '2026-10-16' })).toEqual([]);
    expect(A.healthDayEvents({ day: 'yesterday', steps: 5 })).toEqual([]);
  });

  it('notes sleep (tier 3) and workouts (tier 2) with their own ids', async () => {
    const A = await load();
    const start = Date.UTC(2026, 9, 15, 22, 40);
    const sleep = A.healthSessionEvent({ id: '6f1c2c1e-9a7b-4c43-8a3e-1d2f3a4b5c6d', kind: 'sleep', start, end: start + 7 * HOUR + 20 * MIN, title: '' })!;
    expect(sleep).toMatchObject({ id: 'health:hc-sleep:6f1c2c1e-9a7b-4c43-8a3e-1d2f3a4b5c6d', kind: 'sleep', title: 'Slept 7 h 20 min', value: 440, unit: 'min', tier: 3 });
    const run = A.healthSessionEvent({ id: 'r1', kind: 'workout', start, end: start + 45 * MIN, title: '', type: 'Run' })!;
    expect(run).toMatchObject({ id: 'health:hc-workout:r1', kind: 'workout', title: 'Run, 45 min', tier: 2 });
    expect(A.healthSessionEvent({ id: 'r2', kind: 'workout', start, end: start + 45 * MIN, title: 'Morning laps', type: 'Swim' })!.title).toBe('Morning laps, 45 min');
    expect(A.healthSessionEvent({ id: 'r3', kind: 'workout', start, end: start })).toBeNull();
    expect(A.healthSessionEvent({ id: 'r4', kind: 'nap', start, end: start + HOUR })).toBeNull();
  });

  it('notes calendar events, all-day ones on their own date (tier 2)', async () => {
    const A = await load();
    const begin = Date.UTC(2026, 9, 16, 14);
    expect(A.calendarEvent({ id: 7, begin, end: begin + HOUR, title: 'Dentist', allDay: false })).toMatchObject({ id: `calendar:android:7-${begin}`, source: 'calendar', kind: 'event', at: begin, end: begin + HOUR, title: 'Dentist', tier: 2 });
    const day = Date.UTC(2026, 9, 18);
    const holiday = A.calendarEvent({ id: 8, begin: day, end: day + 2 * DAY, title: '', allDay: true })!;
    expect(holiday).toMatchObject({ at: new Date(2026, 9, 18).getTime(), end: new Date(2026, 9, 20).getTime(), title: 'Busy', meta: { allDay: true } });
    expect(holiday.id).toBe(`calendar:android:8-${day}`);
  });
});

describe("Android's permissions", () => {
  it("is only in the Android app: the web and the iPhone app can't turn anything on", async () => {
    fakePhone('web', []);
    let A = await load();
    expect(A.supported()).toBe(false);
    expect(await A.turnOn('calls')).toBe('unsupported');
    fakePhone('ios', ['Filesystem', 'WebView']);
    A = await load();
    expect(A.inAndroidApp()).toBe(false);
    expect(await A.turnOn('notifications')).toBe('unsupported');
    expect(A.read().on.notifications).toBe(false);
  });

  it('turns calls on when Android allows the call log, and leaves them off when not', async () => {
    const p = fakePhone();
    p.answer.calls = 'denied';
    let A = await load();
    expect(await A.turnOn('calls')).toBe('denied');
    expect(A.read().on.calls).toBe(false);
    p.answer.calls = 'granted';
    A = await load();
    expect(await A.turnOn('calls')).toBe('on');
    expect(A.read().on.calls).toBe(true);
    expect(p.log.find((l) => l.method === 'requestPermissions')?.options).toEqual({ permissions: ['calls', 'contacts'] });
    expect(A.blocked('calls')).toBe('');
    // Taken back in Android's settings later: the switch says what's in the way.
    p.perms.calls = 'denied';
    await A.refreshStatus();
    expect(A.blocked('calls')).toBe('permission');
  });

  it('turns one off when Android says no again, and never leaves the recorder on behind an off switch', async () => {
    const p = fakePhone();
    const A = await load();
    expect(await A.turnOn('calendar')).toBe('on');
    p.answer.calendar = 'denied';
    expect(await A.turnOn('calendar')).toBe('denied'); // "Allow" after taking it back in settings
    expect(A.read().on.calendar).toBe(false);

    p.fail.openSettings = { message: 'No such screen' };
    expect(await A.turnOn('notifications')).toBe('error');
    expect(A.read().on.notifications).toBe(false);
    expect(p.notificationsOn).toBe(false);
  });

  it("opens Notification access for the Player, and starts noting (who and when only) once it's given", async () => {
    const p = fakePhone();
    const A = await load();
    expect(await A.turnOn('notifications')).toBe('settings');
    expect(p.log.filter((l) => l.method === 'openSettings').map((l) => l.options)).toEqual([{ screen: 'notifications' }]);
    expect(p.log.find((l) => l.method === 'setNotifications')?.options).toEqual({ on: true, text: false });
    expect(A.read().on.notifications).toBe(true);
    expect(A.blocked('notifications')).toBe('access');
    p.notificationAccess = true;
    await A.refreshStatus();
    expect(A.blocked('notifications')).toBe('');
    await A.setText(true);
    expect(p.text).toBe(true);
  });

  it('opens Usage access, and Health Connect asks for its own permissions', async () => {
    const p = fakePhone();
    let A = await load();
    expect(await A.turnOn('usage')).toBe('settings');
    expect(p.log.filter((l) => l.method === 'openSettings').map((l) => l.options)).toEqual([{ screen: 'usage' }]);
    p.usageAccess = true;
    await A.refreshStatus();
    expect(A.blocked('usage')).toBe('');

    expect(await A.turnOn('health')).toBe('on');
    expect(A.blocked('health')).toBe('');
    p.healthAnswer = [];
    await A.turnOff('health');
    expect(await A.turnOn('health')).toBe('denied');
    expect(A.read().on.health).toBe(false);
    p.health = 'install';
    A = await load();
    expect(await A.turnOn('health')).toBe('install');
    expect(A.blocked('health')).toBe('install');
    p.health = 'unsupported';
    await A.turnOff('health');
    expect(await A.turnOn('health')).toBe('unsupported');
    expect(A.read().on.health).toBe(false);
  });

  it('turning one off stops it, forgets how far it read, and gives back what Android lets it', async () => {
    const p = fakePhone();
    const A = await load();
    await A.turnOn('calls');
    p.calls.push({ id: 1, number: '1', name: 'Sam', type: 3, date: Date.now() - HOUR, duration: 0 });
    await A.collect();
    expect(A.read().calls).toBeGreaterThan(0);
    await A.turnOff('calls');
    expect(A.read().on.calls).toBe(false);
    expect(A.read().calls).toBeUndefined();
    expect(p.log.at(-3)).toEqual({ method: 'forget', options: { what: 'calls' } });

    p.notificationAccess = true;
    await A.turnOn('notifications');
    queued(p, { key: 'k', pkg: 'com.x', app: 'X', title: 'Hi', at: Date.now() });
    await A.turnOff('notifications');
    expect(p.notificationsOn).toBe(false);
    expect(p.queue).toEqual([]); // what waited is deleted with it
  });
});

describe('handing over to the life log', () => {
  it('adds the notifications that waited while the app was closed, then lets them go', async () => {
    const p = fakePhone();
    p.notificationAccess = true;
    const A = await load();
    await A.turnOn('notifications');
    const at = Date.now() - HOUR;
    queued(p, { key: 'a', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Mum', text: 'secret', at });
    queued(p, { key: 'b', pkg: 'com.google.android.gm', app: 'Gmail', title: 'Bank', at: at + MIN });
    expect(await A.collect()).toBe(2);
    expect([...lifeLog.events.values()].map((e) => e.title)).toEqual(['WhatsApp: Mum', 'Gmail: Bank']);
    expect([...lifeLog.events.values()].every((e) => e.tier === 3 && !e.detail)).toBe(true);
    expect(p.queue).toEqual([]);
    const acks = p.log.filter((l) => l.method === 'ackNotifications');
    expect(acks.map((l) => l.options)).toEqual([{ upTo: 2 }]);
    expect(A.read().last.notifications).toMatchObject({ added: 2 });
    // Nothing new: nothing added.
    expect(await A.collect()).toBe(0);
  });

  it("keeps them on the phone when the life log can't take them, and adds each once later", async () => {
    const p = fakePhone();
    p.notificationAccess = true;
    const A = await load();
    await A.turnOn('notifications');
    queued(p, { key: 'a', pkg: 'com.x', app: 'X', title: 'One', at: Date.now() - HOUR });
    lifeLog.broken = true;
    expect(await A.collect()).toBe(0);
    expect(p.queue).toHaveLength(1);
    expect(p.log.some((l) => l.method === 'ackNotifications')).toBe(false);
    expect(A.read().last.notifications?.error).toBe('The life log is closed.');
    lifeLog.broken = false;
    expect(await A.collect()).toBe(1);
    expect(p.queue).toEqual([]);
    expect(lifeLog.events.size).toBe(1);
  });

  it('takes a long queue a batch at a time', async () => {
    const p = fakePhone();
    p.notificationAccess = true;
    const A = await load();
    await A.turnOn('notifications');
    const at = Date.now() - DAY;
    for (let i = 0; i < 1201; i++) queued(p, { key: `k${i}`, pkg: 'com.x', app: 'X', title: `Message ${i}`, at: at + i });
    expect(await A.collect()).toBe(1201);
    expect(p.log.filter((l) => l.method === 'readNotifications').map((l) => l.options.max)).toEqual([500, 500, 500, 500]);
    expect(p.queue).toEqual([]);
  });

  it('reads calls from where it left off, and adds each call once', async () => {
    const p = fakePhone();
    const now = Date.UTC(2026, 9, 16, 12);
    const A = await load();
    await A.turnOn('calls');
    p.calls.push({ id: 1, number: '1', name: 'Old', type: 1, date: now - 40 * DAY, duration: 60 });
    p.calls.push({ id: 2, number: '2', name: 'Sam', type: 3, date: now - 2 * HOUR, duration: 0 });
    expect(await A.collect(() => now)).toBe(1); // a month back at first, not more
    expect(p.log.find((l) => l.method === 'readCalls')?.options).toEqual({ since: now - 30 * DAY, max: 2000 });
    expect(A.read().calls).toBe(now - 2 * HOUR);
    p.calls.push({ id: 3, number: '3', name: 'Alex', type: 2, date: now - HOUR, duration: 95 });
    expect(await A.collect(() => now + HOUR)).toBe(1);
    expect(p.log.filter((l) => l.method === 'readCalls').at(-1)?.options.since).toBe(now - 2 * HOUR);
    expect([...lifeLog.events.values()].map((e) => e.title)).toEqual(['Missed call from Sam', 'Called Alex (2 min)']);
  });

  it('reads app use in whole hours only, so an hour is never noted half-way', async () => {
    const p = fakePhone();
    p.usageAccess = true;
    const A = await load();
    await A.turnOn('usage');
    const now = new Date(2026, 9, 16, 10, 35).getTime();
    const ten = new Date(2026, 9, 16, 10).getTime();
    const nine = new Date(2026, 9, 16, 9).getTime();
    p.usage.push({ pkg: 'com.x', app: 'X', hour: nine, ms: 20 * MIN }, { pkg: 'com.x', app: 'X', hour: ten, ms: 10 * MIN });
    expect(await A.collect(() => now)).toBe(1);
    expect(p.log.find((l) => l.method === 'readUsage')?.options).toEqual({ from: new Date(2026, 9, 9, 10).getTime(), to: ten });
    expect(A.read().usage).toBe(ten);
    expect(await A.collect(() => now + HOUR)).toBe(1); // 10:00 to 11:00, now over
  });

  it('reads Health Connect days once they are settled, and calendars a little further back each time', async () => {
    const p = fakePhone();
    const A = await load();
    await A.turnOn('health');
    await A.turnOn('calendar');
    const now = new Date(2026, 9, 17, 9).getTime(); // 9 in the morning: yesterday may still be syncing
    p.days.push({ day: '2026-10-15', steps: 9000 }, { day: '2026-10-16', steps: 7000 });
    p.calendar.push({ id: 1, begin: now - 3 * HOUR, end: now - 2 * HOUR, title: 'Gym', allDay: false });
    await A.collect(() => now);
    expect([...lifeLog.events.keys()].sort()).toEqual([`calendar:android:1-${now - 3 * HOUR}`, 'health:hc-steps:2026-10-15']);
    expect(p.log.find((l) => l.method === 'readHealth')?.options).toMatchObject({ fromDay: '2026-09-17', toDay: '2026-10-16' });
    await A.collect(() => now + 6 * HOUR); // 3 in the afternoon
    expect(lifeLog.events.has('health:hc-steps:2026-10-16')).toBe(true);
    expect(p.log.filter((l) => l.method === 'readCalendar').at(-1)?.options.from).toBe(now - 2 * DAY);
  });

  it("notes when Android stopped allowing a read, and doesn't move on", async () => {
    const p = fakePhone();
    const A = await load();
    await A.turnOn('calls');
    p.fail.readCalls = { message: "Arise isn't allowed to read the call log.", code: 'denied' };
    expect(await A.collect()).toBe(0);
    expect(A.read().last.calls?.error).toBe("Android doesn't allow it any more.");
    expect(A.read().calls).toBeUndefined();
  });

  it('reads nothing while everything is off', async () => {
    const p = fakePhone();
    const A = await load();
    expect(await A.collect()).toBe(0);
    expect(p.log).toEqual([]);
  });

  it('keeps only sensible settings from storage', async () => {
    const A = await load();
    expect(A.cleanState({ on: { calls: 'yes', usage: true, bogus: true }, text: 1, calls: -5, usage: 1.7e12, healthDay: 'soon', last: { calls: { at: 'x' }, usage: { at: 1.7e12, added: 3, error: 7 } } })).toEqual({
      on: { notifications: false, calls: false, usage: true, health: false, calendar: false },
      text: false,
      usage: 1.7e12,
      last: { usage: { at: 1.7e12, added: 3 } },
    });
  });
});

describe('Settings, Your life · Android', () => {
  async function panel() {
    const A = await load();
    const UI = await import('./android-ui');
    return { A, UI };
  }

  it('says it is in the Android app only, on the web and on iPhone', async () => {
    fakePhone('web', []);
    expect((await panel()).UI.settingsPanel()).toContain('Android app only.');
    fakePhone('ios', ['Filesystem']);
    expect((await panel()).UI.settingsPanel()).toContain('Android app only.');
  });

  it('has a switch for each, off at first, saying what it reads and where it stays', async () => {
    fakePhone();
    const html = (await panel()).UI.settingsPanel();
    for (const name of ['Notifications', 'Calls', 'App use', 'Health Connect', 'Calendar']) expect(html).toContain(`<b>${name}</b>`);
    expect(html.match(/Stays on this phone and in your encrypted sync\./g)).toHaveLength(5);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(5);
    expect(html).not.toContain('Android app only');
  });

  it("shows what's in the way of one that's on, with a way to fix it", async () => {
    const p = fakePhone();
    const { A, UI } = await panel();
    await A.turnOn('notifications');
    let html = UI.settingsPanel();
    expect(html).toContain('Arise needs Notification access.');
    expect(html).toContain('data-screen="notifications"');
    expect(html).toContain('Allow restricted settings'); // Android 13 and later
    p.notificationAccess = true;
    await A.refreshStatus();
    html = UI.settingsPanel();
    expect(html).not.toContain('Notification access');
    expect(html).toContain('Include what they say');
    expect(html).toContain('Not read yet.');
  });

  it('turns one on and off from its switch', async () => {
    fakePhone();
    const { A, UI } = await panel();
    document.body.innerHTML = `${UI.settingsPanel()}<div id="toast"></div>`;
    const sw = () => document.querySelector<HTMLElement>('[data-act="android-toggle"][data-sense="calendar"]')!;
    expect(await UI.handleAction('android-toggle', sw())).toBe(true);
    expect(A.read().on.calendar).toBe(true);
    expect(sw().getAttribute('aria-pressed')).toBe('true');
    expect(await UI.handleAction('android-toggle', sw())).toBe(true);
    expect(A.read().on.calendar).toBe(false);
    expect(await UI.handleAction('something-else', sw())).toBe(false);
  });
});
