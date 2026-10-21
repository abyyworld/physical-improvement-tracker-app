// @vitest-environment jsdom
// What Arise saw in each day with nothing typed: sleep from Health or worked out from when the
// devices were in use, people, focus, fun and social time, late nights, places, meetings and
// money, each with the tier and the device it came from. Four people: one with only the Mac
// helper, one with an iPhone and Health, one with only the browser extension, and one with
// nothing connected.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';
import type { State } from '../lib/validate';
import { inferSleep, personOf, rowsOf, signalsFrom, sourceWord, spansOf, type DaySignals, type Span } from './signals';

const T = (k: string, h = 12, m = 0, s = 7) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, s).getTime();
};
const MIN = 60000;
const ev = (e: Partial<LifeEvent> & Pick<LifeEvent, 'id' | 'source' | 'kind' | 'at'>): LifeEvent => ({ title: 'Something', tier: 2, ...e });

type St = Pick<State, 'logs' | 'sessions' | 'goals' | 'checks' | 'ai'>;
const st = (x: Partial<St> = {}): St => ({ logs: {}, sessions: [], goals: [], checks: {}, ai: { chat: [] } as unknown as State['ai'], ...x });
const byDay = (xs: DaySignals[]) => Object.fromEntries(xs.map((s) => [s.day, s]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
});

// ---------- the Mac helper only

const macApp = (k: string, h: number, m: number, mins: number, name: string, bundle: string) =>
  ev({ id: `mac:app:${bundle}:${T(k, h, 0, 0)}`, source: 'mac', kind: 'app', at: T(k, h, m), end: T(k, h, m + mins + 5), title: `Used ${name} for ${mins} min`, value: mins, unit: 'min', tier: 2, meta: { app: bundle } });
const macVisit = (k: string, h: number, m: number, site: string, n: number) =>
  ev({ id: `mac:safari:${n}`, source: 'mac', kind: 'visit', at: T(k, h, m), title: `Visited ${site}`, url: `https://${site}/`, tier: 3, meta: { browser: 'safari', device: 'mac', site } });
const macMsg = (k: string, h: number, m: number, out: boolean, who: string, n: number) =>
  ev({ id: `mac:msg:${n}`, source: 'mac', kind: 'message', at: T(k, h, m), title: out ? `Message to ${who}` : `Message from ${who}`, tier: 3, meta: { direction: out ? 'out' : 'in', group: false, with: who } });

// Tuesday 13 and Wednesday 14 October: YouTube in bed until 23:35, a little Reddit after midnight,
// then up at 07:50 with a message to Mum; Code, Slack and a stand-up; GitHub and YouTube in
// Safari after lunch; Sam in the evening, a call to Mum, music before bed. A notification and a
// message that came in at night don't wake anyone.
const MAC: LifeEvent[] = [
  macApp('2026-10-13', 23, 5, 25, 'Safari', 'com.apple.Safari'),
  macVisit('2026-10-13', 23, 10, 'youtube.com', 1),
  macVisit('2026-10-13', 23, 20, 'youtube.com', 2),
  macApp('2026-10-14', 0, 20, 15, 'Safari', 'com.apple.Safari'),
  macVisit('2026-10-14', 0, 25, 'reddit.com', 3),
  ev({ id: 'mac:note:1', source: 'mac', kind: 'notification', at: T('2026-10-14', 3), title: 'Notification from Mail', tier: 3, meta: { app: 'com.apple.mail' } }),
  macMsg('2026-10-14', 3, 30, false, 'sam@icloud.com', 4),
  macMsg('2026-10-14', 7, 50, true, '+44 7700 900123', 5),
  macApp('2026-10-14', 8, 0, 45, 'Code', 'com.microsoft.VSCode'),
  ev({ id: 'mac:mail:g1', source: 'mac', kind: 'message', at: T('2026-10-14', 9), title: 'Email from Shop', tier: 3, meta: { channel: 'email', direction: 'in', with: 'noreply@shop.example' } }),
  macApp('2026-10-14', 9, 0, 50, 'Code', 'com.microsoft.VSCode'),
  ev({ id: 'mac:cal:standup', source: 'mac', kind: 'event', at: T('2026-10-14', 10, 0, 0), end: T('2026-10-14', 11, 0, 0), title: 'Stand-up', tier: 2, meta: { calendar: 'Work' } }),
  ev({ id: 'mac:mail:g2', source: 'mac', kind: 'message', at: T('2026-10-14', 10, 30), title: 'Email from Jane', tier: 3, meta: { channel: 'email', direction: 'in', with: 'jane@work.example' } }),
  macApp('2026-10-14', 11, 0, 25, 'Slack', 'com.tinyspeck.slackmacgap'),
  macApp('2026-10-14', 13, 0, 30, 'Safari', 'com.apple.Safari'),
  macVisit('2026-10-14', 13, 5, 'github.com', 6),
  macVisit('2026-10-14', 13, 15, 'github.com', 7),
  macVisit('2026-10-14', 13, 30, 'youtube.com', 8),
  macMsg('2026-10-14', 19, 0, false, 'sam@icloud.com', 9),
  macMsg('2026-10-14', 19, 5, true, 'sam@icloud.com', 10),
  ev({ id: 'mac:call:1', source: 'mac', kind: 'call', at: T('2026-10-14', 20), end: T('2026-10-14', 20, 12), title: 'Call to Mum, 12 min', value: 12, unit: 'min', tier: 3, meta: { direction: 'out', missed: false, with: '+447700900123' } }),
  macApp('2026-10-14', 22, 0, 40, 'Music', 'com.apple.Music'),
];

describe('a person with only the Mac helper', () => {
  const days = byDay(signalsFrom(MAC, '2026-10-13', '2026-10-14', st()));
  const d = days['2026-10-14'];

  it('works out the night from when the Mac was last and first in use', () => {
    // Reddit until 00:40, then nothing (the night's notification and message don't count) until
    // the message to Mum at 07:50.
    expect(d).toMatchObject({ sleepMin: 430, sleepFrom: 'inferred', bedtime: 40, wake: 470 });
    expect(d.tier.sleepMin).toBe(3);
    expect(d.from.sleepMin).toEqual(['Mac']);
    // Up after midnight: Safari from 00:20 for 15 minutes.
    expect(d).toMatchObject({ lateMin: 15, tier: { lateMin: 3 } });
  });

  it('splits Safari by the sites visited in that hour, and adds up work, fun and social time', () => {
    // Code 95 + Slack 25 + two thirds of 30 min of Safari on GitHub; Music 40 + a third on YouTube;
    // Reddit after midnight.
    expect(d).toMatchObject({ focusMin: 140, funMin: 50, socialMin: 15, screenMin: 205 });
    expect(d.top).toEqual({ work: ['Code', 'Slack', 'GitHub'], fun: ['Music', 'YouTube'], social: ['Reddit'] });
    // App use is everyday activity; what was read from browsing is sensitive.
    expect(d.tier).toMatchObject({ focusMin: 3, funMin: 3, socialMin: 3, screenMin: 3 });
    expect(d.from.focusMin).toEqual(['Mac']);
  });

  it('counts the people in touch once each, with Jane by email but not a newsletter', () => {
    // Mum by message and by phone (the same number written two ways), Sam, and Jane.
    expect(d).toMatchObject({ people: 3, calls: 1, messages: 4, talked: true, tier: { people: 3 } });
    // Tuesday is before the first message: unknown, not "no one".
    expect(days['2026-10-13'].people).toBeUndefined();
  });

  it('takes the stand-up as a meeting and leaves out what it has no source for', () => {
    expect(d).toMatchObject({ meetingsMin: 60, tier: { meetingsMin: 2 }, from: { meetingsMin: ['Mac'] } });
    for (const f of ['steps', 'active', 'places', 'outside', 'spent', 'due'] as const) expect(d[f]).toBeUndefined();
  });
});

// ---------- an iPhone with Health

const HEALTH: LifeEvent[] = [
  ev({ id: 'health:sleep:2026-10-14', source: 'health', kind: 'sleep', at: T('2026-10-13', 23, 10, 0), end: T('2026-10-14', 6, 50, 0), title: 'Slept 6 h 40 min', value: 400, unit: 'min', tier: 3 }),
  ev({ id: 'health:day:2026-10-14', source: 'health', kind: 'steps', at: T('2026-10-14', 0, 0, 0), end: T('2026-10-15', 0, 0, 0), title: '6,400 steps', value: 6400, unit: 'steps', tier: 2 }),
  ev({ id: 'health:workout:run1', source: 'health', kind: 'workout', at: T('2026-10-14', 7, 10), end: T('2026-10-14', 7, 40), title: 'Running, 30 min', value: 30, unit: 'min', tier: 2 }),
  ev({ id: 'maps:visit:1', source: 'maps', kind: 'place', at: T('2026-10-13', 18, 30), end: T('2026-10-14', 7, 5), title: 'At Home', tier: 3, meta: { lat: 51.5001, lon: -0.1001 } }),
  ev({ id: 'maps:visit:2', source: 'maps', kind: 'place', at: T('2026-10-14', 7, 8), end: T('2026-10-14', 7, 45), title: 'At the gym', tier: 3, meta: { lat: 51.51, lon: -0.12 } }),
  ev({ id: 'maps:motion:walking:1', source: 'maps', kind: 'trip', at: T('2026-10-14', 8, 10), end: T('2026-10-14', 8, 35), title: 'Walked for 25 min', value: 25, unit: 'min', tier: 2, meta: { mode: 'walking' } }),
  ev({ id: 'maps:visit:3', source: 'maps', kind: 'place', at: T('2026-10-14', 8, 40), end: T('2026-10-14', 17, 30), title: 'At the office', tier: 3, meta: { lat: 51.52, lon: -0.08 } }),
  ev({ id: 'calendar:dentist:1', source: 'calendar', kind: 'event', at: T('2026-10-14', 14, 0, 0), end: T('2026-10-14', 15, 30, 0), title: 'Dentist', tier: 2 }),
  ev({ id: 'calendar:holiday:1', source: 'calendar', kind: 'event', at: T('2026-10-13', 0, 0, 0), end: T('2026-10-14', 0, 0, 0), title: 'Holiday', tier: 2, meta: { allDay: true } }),
  ev({ id: 'shortcut:m1', source: 'shortcut', kind: 'message', at: T('2026-10-14', 12), title: 'Message: Alex', tier: 3, meta: { via: 'message' } }),
];
const SESSION = { id: 's1', workout: 'a', date: '2026-10-14', started: T('2026-10-14', 18), finished: T('2026-10-14', 18, 45), easy: false, items: [] };

describe('a person with an iPhone and Health', () => {
  const days = byDay(signalsFrom(HEALTH, '2026-10-13', '2026-10-14', st({ sessions: [SESSION] as unknown as State['sessions'] })));
  const d = days['2026-10-14'];

  it("takes Health's night, with when it started and ended", () => {
    expect(d).toMatchObject({ sleepMin: 400, sleepFrom: 'health', bedtime: -50, wake: 410, tier: { sleepMin: 3 }, from: { sleepMin: ['phone'] } });
  });

  it("adds Arise's workouts to the ones Health recorded", () => {
    expect(d).toMatchObject({ steps: 6400, active: 75, trained: true, tier: { steps: 2, active: 2 } });
    expect(d.from.active).toEqual(['phone', 'Arise']);
    // Monday: nothing recorded, and Health would have.
    expect(days['2026-10-13']).toMatchObject({ active: 0, trained: false });
  });

  it('counts the places other than home (where they were at 3 am), and being out', () => {
    expect(d).toMatchObject({ places: 2, outside: true, tier: { places: 3 }, from: { places: ['phone'] } });
    expect(days['2026-10-13']).toMatchObject({ places: 0, outside: false });
  });

  it('takes timed calendar events as meetings, not all-day ones, and a message from Shortcuts as someone', () => {
    expect(d).toMatchObject({ meetingsMin: 90, from: { meetingsMin: ['phone'] } });
    expect(days['2026-10-13'].meetingsMin).toBe(0);
    expect(d).toMatchObject({ people: 1, messages: 1, calls: 0 });
  });

  it('knows there were no late nights, and nothing about screens', () => {
    // Arriving home at 18:30 and leaving at 07:05 show the phone was there that night.
    expect(d.lateMin).toBe(0);
    expect(d.screenMin).toBeUndefined();
    expect(d.focusMin).toBeUndefined();
  });
});

// ---------- the browser extension only

const site = (k: string, h: number, mins: number, s: string, browser = 'Chrome on Windows') =>
  ev({ id: `browser:${s}:${k}:${h}`, source: 'browser', kind: 'app', at: T(k, h, 0, 0), end: T(k, h, mins + 5), title: `${mins} min on ${s}`, detail: s, value: mins, unit: 'min', tier: 3, meta: { site: s, seconds: mins * 60, browser } });
const BROWSER: LifeEvent[] = [
  site('2026-10-13', 23, 25, 'youtube.com'),
  site('2026-10-14', 7, 10, 'bbc.co.uk'),
  site('2026-10-14', 9, 40, 'github.com'),
  site('2026-10-14', 10, 30, 'docs.google.com'),
  site('2026-10-14', 21, 55, 'youtube.com'),
  site('2026-10-14', 22, 20, 'instagram.com'),
  ev({ id: 'browser:v1', source: 'browser', kind: 'visit', at: T('2026-10-14', 9, 3), title: 'Pull requests', url: 'https://github.com/pulls', tier: 3, meta: { site: 'github.com', browser: 'Chrome on Windows' } }),
];

describe('a person with only the browser extension', () => {
  const d = byDay(signalsFrom(BROWSER, '2026-10-13', '2026-10-14', st()))['2026-10-14'];

  it('adds up time on each kind of site', () => {
    expect(d).toMatchObject({ focusMin: 70, funMin: 55, socialMin: 20, screenMin: 155 });
    expect(d.top).toEqual({ work: ['GitHub', 'Google Docs'], fun: ['YouTube'], social: ['Instagram'] });
    expect(d.from.screenMin).toEqual(['browser']);
  });

  it('works out the night from the last site at night and the first in the morning', () => {
    // YouTube until 23:30 (the hour's 25 minutes up to its end), the news from 07:05.
    expect(d).toMatchObject({ sleepMin: 455, sleepFrom: 'inferred', bedtime: -30, wake: 425, from: { sleepMin: ['browser'] } });
    expect(d.lateMin).toBe(0);
  });

  it("doesn't count a Mac browser twice when the extension timed it", () => {
    const both = [
      ev({ id: 'mac:app:chrome', source: 'mac', kind: 'app', at: T('2026-10-14', 13, 5), end: T('2026-10-14', 13, 50), title: 'Used Google Chrome for 40 min', value: 40, unit: 'min', tier: 2, meta: { app: 'com.google.Chrome' } }),
      site('2026-10-14', 13, 30, 'youtube.com', 'Chrome on macOS'),
    ];
    const x = byDay(signalsFrom(both, '2026-10-14', '2026-10-14', st()))['2026-10-14'];
    // 30 minutes of YouTube from the extension, and the 10 minutes of Chrome it didn't time.
    expect(x).toMatchObject({ screenMin: 40, funMin: 30, focusMin: 0 });
    expect(x.from.screenMin).toEqual(['Mac', 'browser']);
    // Safari in the same hour is other time: the extension was in Chrome.
    const safari = macApp('2026-10-14', 13, 0, 20, 'Safari', 'com.apple.Safari');
    expect(byDay(signalsFrom([...both, safari], '2026-10-14', '2026-10-14', st()))['2026-10-14']).toMatchObject({ screenMin: 60, funMin: 30 });
    // On Windows it's another computer: both count.
    const windows = [both[0], site('2026-10-14', 13, 30, 'youtube.com', 'Chrome on Windows')];
    expect(byDay(signalsFrom(windows, '2026-10-14', '2026-10-14', st()))['2026-10-14']).toMatchObject({ screenMin: 70, funMin: 30 });
  });
});

// ---------- nothing connected

describe('a person with nothing connected', () => {
  const goals = [
    { id: 'g1', title: 'Get a new job', category: 'career', why: '', by: '', created: '2026-10-01', updated: 1, status: 'active', quests: [{ id: 'q1', title: 'Apply to one job', schedule: { kind: 'daily' }, created: '2026-10-01' }], milestones: [], measures: [] },
    { id: 'g2', title: 'Save for a car', category: 'money', why: '', by: '', created: '2026-10-01', updated: 1, status: 'active', quests: [{ id: 'q2', title: 'No takeaways', schedule: { kind: 'daily' }, created: '2026-10-01' }], milestones: [], measures: [] },
  ] as unknown as State['goals'];
  const data = st({
    goals,
    checks: { '2026-10-14': { q1: { done: true, at: T('2026-10-14', 7, 31) } } },
    logs: { '2026-10-13': { m: 2, at: T('2026-10-13', 23, 1) }, '2026-10-14': { s: 4, e: 3, m: 4, at: T('2026-10-14', 7, 30) } },
  });
  const days = byDay(signalsFrom([], '2026-10-13', '2026-10-14', data));

  it('has only their quests and their own check-in, when there is one', () => {
    expect(days['2026-10-14']).toEqual({
      day: '2026-10-14',
      trained: false,
      due: 2,
      done: 1,
      questsBy: { career: { due: 1, done: 1 }, money: { due: 1, done: 0 } },
      mood: 4,
      s: 4,
      e: 3,
      m: 4,
      tier: { trained: 1, quests: 1, mood: 1 },
      from: { trained: ['Arise'], quests: ['Arise'], mood: ['Arise'] },
    });
  });

  it("doesn't make up a night from Arise alone", () => {
    // A check-in at 23:01 and another at 07:30 aren't enough to say they slept between.
    expect(days['2026-10-14'].sleepMin).toBeUndefined();
    expect(days['2026-10-14'].lateMin).toBeUndefined();
  });
});

// ---------- sleep from activity

const span = (from: number, to: number, x: Partial<Span> = {}): Span => ({ from, to, use: to - from, tier: 2, word: 'phone', ...x });
const at = (h: number, m = 0, k = '2026-10-14') => T(k, h, m, 0);
const eve = (h: number, m = 0) => at(h, m, '2026-10-13');

describe('working out a night from activity', () => {
  it('takes the longest gap in the night, with activity on both sides', () => {
    const n = inferSleep([span(eve(22), eve(23, 15)), span(at(6, 45), at(7, 30)), span(at(9), at(9, 30))], '2026-10-14');
    expect(n).toMatchObject({ min: 450, bed: eve(23, 15), wake: at(6, 45), tier: 3, from: ['phone'] });
  });

  it('needs activity on both sides', () => {
    expect(inferSleep([span(eve(22), eve(23, 15))], '2026-10-14')).toBeNull();
    expect(inferSleep([span(at(7), at(8))], '2026-10-14')).toBeNull();
    // Before 18:00 is the day before, not the evening.
    expect(inferSleep([span(eve(17), eve(17, 30)), span(at(7), at(8))], '2026-10-14')).toBeNull();
    expect(inferSleep([], '2026-10-14')).toBeNull();
  });

  it('keeps 3 to 12 hours, from 21:00 at the earliest', () => {
    // From 21:00 to 09:00 is still a night; to 09:01 too long to be sure; 01:00 to 03:30 too short.
    expect(inferSleep([span(eve(20, 30), eve(21)), span(at(9), at(9, 30))], '2026-10-14')).toMatchObject({ min: 720 });
    expect(inferSleep([span(eve(20, 30), eve(21)), span(at(9, 1), at(9, 30))], '2026-10-14')).toBeNull();
    // A laptop shut at 18:55 and opened at 08:30 is a gap, not a night of 13 h 35 min; nor is
    // 19:00 to 08:00.
    expect(inferSleep([span(eve(18), eve(18, 55)), span(at(8, 30), at(9, 30))], '2026-10-14')).toBeNull();
    expect(inferSleep([span(eve(18, 30), eve(19)), span(at(8), at(9))], '2026-10-14')).toBeNull();
    expect(inferSleep([span(eve(23), at(1)), span(at(3, 30), at(13, 59))], '2026-10-14')).toBeNull();
    expect(inferSleep([span(eve(23), at(1)), span(at(4), at(13, 59))], '2026-10-14')).toMatchObject({ min: 180 });
  });

  it('keeps a few minutes up in the night as part of it', () => {
    // On the phone at 03:10 for 5 minutes, asleep before and after.
    const n = inferSleep([span(eve(23), eve(23, 30)), span(at(3, 10), at(3, 15)), span(at(7), at(7, 30))], '2026-10-14');
    expect(n).toMatchObject({ min: 445, bed: eve(23, 30), wake: at(7) });
    // But not a last look at the phone just after going to bed.
    const late = inferSleep([span(eve(23), eve(23, 30)), span(eve(23, 40), eve(23, 50)), span(at(7), at(7, 30))], '2026-10-14');
    expect(late).toMatchObject({ min: 430, bed: eve(23, 50) });
  });

  it("doesn't take a nap or an evening out for the night", () => {
    // Out from 18:30 to 22:30 without the phone, a short night, and a nap from 09:00 to 12:00:
    // the night is the one in the middle.
    const n = inferSleep([span(eve(18, 10), eve(18, 30)), span(eve(22, 30), at(1)), span(at(6), at(8, 55)), span(at(12), at(12, 30))], '2026-10-14');
    expect(n).toMatchObject({ bed: at(1), wake: at(6), min: 300 });
  });

  it("doesn't call a night drive sleep", () => {
    // Driving home through the night: the trip itself is activity.
    const trip = spansOf(ev({ id: 'maps:motion:automotive:1', source: 'maps', kind: 'trip', at: at(0, 30), end: at(4, 0), title: 'Drove for 3 h 30 min', tier: 2 }));
    const n = inferSleep([span(eve(21), eve(23, 50)), ...trip, span(at(7, 30), at(8))], '2026-10-14');
    expect(n).toMatchObject({ bed: at(4), wake: at(7, 30), min: 210 });
  });

  it("needs something other than Arise itself", () => {
    expect(inferSleep([span(eve(23), eve(23, 1), { own: true, word: 'Arise' }), span(at(7), at(7, 1), { own: true, word: 'Arise' })], '2026-10-14')).toBeNull();
    const n = inferSleep([span(eve(23), eve(23, 1), { own: true, word: 'Arise', tier: 1 }), span(at(7), at(7, 1), { tier: 2 })], '2026-10-14');
    expect(n).toMatchObject({ min: 479, tier: 3, from: ['phone'] });
  });
});

describe('what shows the Player awake', () => {
  it('counts what they did, not what came in while they slept', () => {
    const k = '2026-10-14';
    expect(spansOf(macMsg(k, 3, 0, true, 'Sam', 1))).toHaveLength(1);
    expect(spansOf(macMsg(k, 3, 0, false, 'Sam', 1))).toEqual([]);
    expect(spansOf(ev({ id: 'android:note:1', source: 'android', kind: 'notification', at: at(3), title: 'WhatsApp: Sam' }))).toEqual([]);
    expect(spansOf(ev({ id: 'android:call:1', source: 'android', kind: 'call', at: at(3), title: 'Missed call from Sam', meta: { missed: true } }))).toEqual([]);
    expect(spansOf(ev({ id: 'spotify:1', source: 'spotify', kind: 'listen', at: at(3), end: at(3, 4), title: 'Listened to Rain sounds' }))).toEqual([]);
    expect(spansOf(ev({ id: 'netflix:1', source: 'netflix', kind: 'watch', at: at(12, 0), title: 'Watched Dark', meta: { dateOnly: true } }))).toEqual([]);
    // A day's steps total isn't a time; steps with one are.
    expect(spansOf(HEALTH[1])).toEqual([]);
    expect(spansOf(ev({ id: 'health:steps:h', source: 'health', kind: 'steps', at: at(7), end: at(7, 30), title: '900 steps', value: 900 }))).toHaveLength(1);
  });

  it("places Android's minutes in the middle of their hour, and the extension's before its end", () => {
    const android = ev({ id: 'android:app:x:1', source: 'android', kind: 'app', at: at(1), title: 'Used Instagram for 10 min', value: 10, unit: 'min', meta: { app: 'Instagram', pkg: 'com.instagram.android' } });
    expect(spansOf(android)).toEqual([{ from: at(1, 25), to: at(1, 35), use: 10 * MIN, tier: 2, word: 'phone', screen: true }]);
    // 25 minutes on YouTube in the hour from 23:00, the last at 23:30.
    expect(spansOf(site('2026-10-14', 23, 25, 'youtube.com'))[0]).toMatchObject({ from: T('2026-10-14', 23, 5), to: T('2026-10-14', 23, 30), use: 25 * MIN });
  });

  it("leaves out Arise's moments with no time of their own", () => {
    // A quest ticked for another day goes in at noon exactly.
    expect(spansOf(ev({ id: 'arise:quest:1', source: 'arise', kind: 'quest', at: at(12), title: 'Done: Read', tier: 1 }))).toEqual([]);
    expect(spansOf(ev({ id: 'arise:quest:2', source: 'arise', kind: 'quest', at: T('2026-10-14', 23, 12, 40), title: 'Done: Read', tier: 1 }))).toHaveLength(1);
  });
});

describe('who someone was in touch with', () => {
  it('knows a person by number, address or name, and not a newsletter or the coach', () => {
    expect(personOf(macMsg('2026-10-14', 9, 0, true, '+44 7700 900123', 1))).toBe(personOf(ev({ id: 'android:call:1', source: 'android', kind: 'call', at: 1, title: 'Called Mum (2 min)', meta: { number: '07700 900123' } })));
    expect(personOf(ev({ id: 'whatsapp:1', source: 'whatsapp', kind: 'message', at: 1, title: 'Chatted with Family: 12 messages', value: 12, unit: 'messages', meta: { chat: 'Family' } }))).toBe('family');
    expect(personOf(ev({ id: 'android:call:2', source: 'android', kind: 'call', at: 1, title: 'Call from Sam (3 min)', meta: { name: 'Sam' } }))).toBe('sam');
    expect(personOf(ev({ id: 'mac:mail:1', source: 'mac', kind: 'message', at: 1, title: 'Email from The Times', meta: { channel: 'email', with: 'newsletter@thetimes.example' } }))).toBe('');
    expect(personOf(ev({ id: 'mac:mail:2', source: 'mac', kind: 'message', at: 1, title: 'Email from Team Notion', meta: { channel: 'email', with: 'notify@mail.notion.so' } }))).toBe('');
    expect(personOf(ev({ id: 'arise:chat:1', source: 'arise', kind: 'message', at: 1, title: 'Asked the coach: why?' }))).toBe('');
    expect(personOf(ev({ id: 'android:call:3', source: 'android', kind: 'call', at: 1, title: 'Missed call from Sam', meta: { missed: true, name: 'Sam' } }))).toBe('');
  });
});

describe('the rest of the signals', () => {
  it('adds up money out from bank statements, only between their first and last day', () => {
    const bank = [
      ev({ id: 'bank:1', source: 'bank', kind: 'purchase', at: T('2026-10-12', 12, 0, 0), title: 'Spent £20.50 at Cafe', value: -20.5, unit: 'GBP', tier: 3 }),
      ev({ id: 'bank:2', source: 'bank', kind: 'purchase', at: T('2026-10-14', 12, 0, 0), title: 'Spent £12.00 at Shop', value: -12, unit: 'GBP', tier: 3 }),
      ev({ id: 'bank:3', source: 'bank', kind: 'purchase', at: T('2026-10-14', 12, 0, 0), title: 'Received £100.00: Pay', value: 100, unit: 'GBP', tier: 3, meta: { in: true } }),
    ];
    const d = byDay(signalsFrom(bank, '2026-10-11', '2026-10-15', st()));
    expect(d['2026-10-11'].spent).toBeUndefined();
    expect(d['2026-10-12']).toMatchObject({ spent: 20.5, spentUnit: 'GBP', tier: { spent: 3 }, from: { spent: ['bank statements'] } });
    expect(d['2026-10-13'].spent).toBe(0);
    expect(d['2026-10-14'].spent).toBe(12);
    expect(d['2026-10-15'].spent).toBeUndefined();
  });

  it("adds games played elsewhere to fun, with the game's name", () => {
    const psn = ev({ id: 'psn:1', source: 'psn', kind: 'play', at: T('2026-10-14', 20), end: T('2026-10-14', 21, 30), title: 'Played Astro Bot for 1 h 30 min', value: 90, unit: 'min', tier: 2, meta: { app: 'playstation', game: 'Astro Bot' } });
    const d = byDay(signalsFrom([psn], '2026-10-14', '2026-10-14', st()))['2026-10-14'];
    expect(d).toMatchObject({ funMin: 90, top: { fun: ['Astro Bot'] }, tier: { funMin: 2 }, from: { funMin: ['imports'] } });
    expect(d.screenMin).toBeUndefined();
  });

  it('names where things came from in plain words', () => {
    expect(sourceWord({ source: 'android', id: 'android:app:x' })).toBe('phone');
    expect(sourceWord({ source: 'maps', id: 'maps:motion:walking:1' })).toBe('phone');
    expect(sourceWord({ source: 'maps', id: 'maps:abc' })).toBe('imports');
    expect(sourceWord({ source: 'mac', id: 'mac:app:x' })).toBe('Mac');
    expect(sourceWord({ source: 'browser', id: 'browser:x' })).toBe('browser');
    expect(sourceWord({ source: 'bank', id: 'bank:x' })).toBe('bank statements');
    expect(sourceWord({ source: 'arise', id: 'arise:x' })).toBe('Arise');
  });
});

describe('rows for the patterns', () => {
  it('carries the signals over with their tiers', () => {
    const rows = rowsOf(signalsFrom(MAC, '2026-10-13', '2026-10-14', st()));
    expect(rows[1]).toMatchObject({
      day: '2026-10-14',
      sleepMin: 430,
      sleepFrom: 'inferred',
      people: true,
      peopleN: 3,
      focusMin: 140,
      funMin: 50,
      socialMin: 15,
      lateMin: 15,
      screenMin: 205,
      calMin: 60,
      trained: false,
      tier: { sleepMin: 3, people: 3, peopleN: 3, focusMin: 3, lateMin: 3, screenMin: 3, calMin: 2, trained: 1 },
    });
    expect(rows[0].peopleN).toBeUndefined();
  });
});

describe('reading the life log', () => {
  it('reads every kind it needs from the log on this device', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    localStorage.setItem('pit-data-v1', JSON.stringify({}));
    const L = await import('./log');
    expect(await L.addEvents(MAC)).toBe(MAC.length);
    const { daySignals } = await import('./signals');
    const d = byDay(await daySignals('2026-10-13', '2026-10-14'))['2026-10-14'];
    expect(d).toMatchObject({ sleepMin: 430, people: 3, focusMin: 140, lateMin: 15, meetingsMin: 60 });
  });
});

// ---------- 1.16 review: each case as the sources really send it

describe('people, from what the sources really send', () => {
  const k = '2026-10-14';
  const people = (evs: LifeEvent[]) => byDay(signalsFrom(evs, k, k, st()))[k];

  it('knows Gmail and Outlook emails by address, not by subject, and leaves out machines', () => {
    const gmail = (n: number, from: string, subject: string) => ev({ id: `email:gmail:${n}`, source: 'email', kind: 'message', at: T(k, 9 + n), title: `Email from ${from.replace(/\s*<.*$/, '').replace(/"/g, '')}: ${subject}`, tier: 3, meta: { app: 'gmail', from, unread: true } });
    const d = people([
      gmail(1, 'Jane Doe <jane@example.com>', 'Lunch?'),
      gmail(2, 'Jane Doe <jane@example.com>', 'Re: Friday'),
      gmail(3, 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Your order has shipped'),
      gmail(4, '"My Bank" <no.reply@mybank.example>', 'Your statement is ready'),
      gmail(5, 'Trainline <account-noreply@trainline.example>', 'Your e-ticket'),
      ev({ id: 'email:outlook:1', source: 'email', kind: 'message', at: T(k, 15), title: 'Emailed Bob Smith: Notes from today', tier: 3, meta: { app: 'outlook', folder: 'Sent', to: 'bob@example.com' } }),
      ev({ id: 'email:outlook:2', source: 'email', kind: 'message', at: T(k, 16), title: 'Email from Jane Doe: Notes', tier: 3, meta: { app: 'outlook', folder: 'Inbox', from: 'Jane Doe <jane@example.com>' } }),
    ]);
    expect(d).toMatchObject({ people: 2, messages: 0, calls: 0 });
  });

  it("doesn't take a Shortcut's message text for a person, and doesn't count its emails as being in touch", () => {
    const sc = (n: number, via: 'message' | 'email', what: string) => ev({ id: `shortcut:${n}`, source: 'shortcut', kind: 'message', at: T(k, 10 + n), title: `${via === 'email' ? 'Email' : 'Message'}: ${what}`, tier: 3, meta: { via } });
    const d = people([sc(1, 'message', 'See you at 7'), sc(2, 'message', 'ok cool'), sc(3, 'message', 'on my way home now'), sc(4, 'email', 'Your invoice is ready'), sc(5, 'message', 'Alex Smith')]);
    // Alex, picked as the Sender; the rest are what the messages said.
    expect(d).toMatchObject({ people: 1, messages: 4 });
    const email = people([sc(4, 'email', 'Your invoice is ready')]);
    expect(email.people).toBe(0);
    expect(email.talked).toBeUndefined();
  });

  it("doesn't count texts from short codes and companies as people", () => {
    const d = people([macMsg(k, 8, 0, false, '72975', 1), macMsg(k, 9, 0, false, 'AMAZON', 2), macMsg(k, 10, 0, false, 'HMRC', 3), macMsg(k, 11, 0, false, '+44 7700 900456', 4)]);
    expect(d).toMatchObject({ people: 1, messages: 4 });
  });

  it("doesn't count a call nobody answered", () => {
    const d = people([
      ev({ id: 'android:call:1', source: 'android', kind: 'call', at: T(k, 18), title: 'Called Mum (no answer)', tier: 3, meta: { direction: 'out', missed: false, name: 'Mum', number: '07700 900123' } }),
      ev({ id: 'mac:call:1', source: 'mac', kind: 'call', at: T(k, 19), title: 'Call to Sam, no answer', tier: 3, meta: { direction: 'out', missed: false, type: 'phone', with: '+447700900999' } }),
    ]);
    expect(d).toMatchObject({ people: 0, calls: 0, talked: false });
  });
});

describe('sleep, from what the sources really send', () => {
  const code = (k: string, h: number, m: number, mins: number) => macApp(k, h, m, mins, 'Code', 'com.microsoft.VSCode');

  it("doesn't take a few minutes up in the night for the morning before the morning's use comes in", () => {
    vi.setSystemTime(new Date(2026, 9, 14, 7, 10));
    // Code until 22:55, 3 minutes of Safari at 04:50; the Mac use from 07:05 isn't in yet.
    const night = [code('2026-10-13', 22, 0, 50), macApp('2026-10-14', 4, 50, 3, 'Safari', 'com.apple.Safari')];
    expect(byDay(signalsFrom(night, '2026-10-14', '2026-10-14', st()))['2026-10-14'].sleepMin).toBeUndefined();
    // Once it is, the night runs to 07:05 with the few minutes up in it.
    vi.setSystemTime(new Date(2026, 9, 14, 8, 30));
    expect(byDay(signalsFrom([...night, code('2026-10-14', 7, 5, 20)], '2026-10-14', '2026-10-14', st()))['2026-10-14']).toMatchObject({ sleepMin: 482, bedtime: -65, wake: 425 });
  });

  it("doesn't work out tonight's sleep while it's still night", () => {
    vi.setSystemTime(new Date(2026, 9, 14, 1, 30));
    const d = byDay(signalsFrom([code('2026-10-13', 18, 0, 50), code('2026-10-13', 20, 30, 50), code('2026-10-14', 1, 0, 20)], '2026-10-14', '2026-10-14', st()))['2026-10-14'];
    expect(d.sleepMin).toBeUndefined();
  });

  it("doesn't make up a night from two check-ins with the Mac in use only the next afternoon", () => {
    const logs = { '2026-10-13': { m: 3, at: T('2026-10-13', 22, 30) }, '2026-10-14': { m: 4, at: T('2026-10-14', 7, 0) } } as unknown as State['logs'];
    const d = byDay(signalsFrom([code('2026-10-14', 12, 30, 25)], '2026-10-14', '2026-10-14', st({ logs })))['2026-10-14'];
    expect(d.sleepMin).toBeUndefined();
  });

  it('keeps bedtime and waking on the clock the night the clocks go back', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/London';
    try {
      vi.setSystemTime(new Date(2026, 9, 25, 12));
      // Code until 22:30 (summer time), then from 07:00 (winter time): 9 h 30 min asleep.
      const d = byDay(signalsFrom([code('2026-10-24', 21, 50, 35), code('2026-10-25', 7, 0, 30)], '2026-10-25', '2026-10-25', st()))['2026-10-25'];
      expect(d).toMatchObject({ sleepMin: 570, bedtime: -90, wake: 420 });
    } finally {
      process.env.TZ = zone;
    }
  });
});

describe('the body, from what the sources really send', () => {
  const k = '2026-10-14';

  it('counts Health read live and from its export once: steps and workouts', () => {
    const live = [
      ev({ id: `health:day:${k}`, source: 'health', kind: 'steps', at: T(k, 0, 0, 0), end: T('2026-10-15', 0, 0, 0), title: '6,400 steps, 4.8 km on foot', value: 6400, unit: 'steps', tier: 2, meta: { steps: 6400, km: 4.8 } }),
      ev({ id: 'health:workout:9F2C', source: 'health', kind: 'workout', at: T(k, 7, 10, 0), end: T(k, 7, 40, 0), title: 'Running, 30 min, 5.1 km', value: 30, unit: 'min', tier: 2, meta: { type: 'running', km: 5.1 } }),
    ];
    const zip = [
      ev({ id: `health:steps:${k}`, source: 'health', kind: 'steps', at: T(k, 0, 0, 0), end: T('2026-10-15', 0, 0, 0), title: '6,400 steps', value: 6400, unit: 'count', tier: 2, meta: { day: k } }),
      ev({ id: 'health:a81f30', source: 'health', kind: 'workout', at: T(k, 7, 10, 0), end: T(k, 7, 40, 0), title: 'Running · 30 min · 5.1 km', value: 30, unit: 'min', tier: 2, meta: { activity: 'Running', km: 5.1 } }),
    ];
    expect(byDay(signalsFrom([...live, ...zip], k, k, st()))[k]).toMatchObject({ steps: 6400, active: 30, trained: true });
  });

  it('counts an Arise workout the watch recorded too once', () => {
    const watch = ev({ id: 'health:workout:77AB', source: 'health', kind: 'workout', at: T(k, 18, 0, 0), end: T(k, 18, 45, 0), title: 'Strength training, 45 min', value: 45, unit: 'min', tier: 2 });
    expect(byDay(signalsFrom([watch], k, k, st({ sessions: [SESSION] as unknown as State['sessions'] })))[k]).toMatchObject({ active: 45, trained: true });
  });

  it('counts football as a workout', () => {
    const days = byDay(signalsFrom([], '2026-10-13', k, { ...st(), football: [k] }));
    expect(days[k]).toMatchObject({ trained: true, active: 90, from: { active: ['Arise'] } });
    expect(days['2026-10-13']).toMatchObject({ trained: false, active: 0 });
    // A match the watch recorded: its own length, not 90 minutes on top.
    const watch = ev({ id: 'health:workout:5C', source: 'health', kind: 'workout', at: T(k, 19, 0, 0), end: T(k, 20, 10, 0), title: 'Soccer, 1 h 10 min', value: 70, unit: 'min', tier: 2, meta: { type: 'soccer' } });
    expect(byDay(signalsFrom([watch], k, k, { ...st(), football: [k] }))[k].active).toBe(70);
  });
});

describe('screens and places, from what the sources really send', () => {
  const k = '2026-10-14';

  it("doesn't add Netflix's history on top of the same time in the browser or the app", () => {
    const netflix = (n: number, h: number, m: number, mins: number) => ev({ id: `netflix:${n}`, source: 'netflix', kind: 'watch', at: T(k, h, m, 0), end: T(k, h, m + mins, 0), title: `Watched Dark: Season 1: Episode ${n}`, value: mins, unit: 'min', tier: 2, meta: { profile: 'Sam' } });
    const browser = [site(k, 20, 55, 'netflix.com'), site(k, 21, 50, 'netflix.com'), netflix(1, 20, 2, 50), netflix(2, 20, 55, 50)];
    expect(byDay(signalsFrom(browser, k, k, st()))[k]).toMatchObject({ funMin: 105, screenMin: 105 });
    const android = [ev({ id: 'android:app:netflix:1', source: 'android', kind: 'app', at: T(k, 20, 0, 0), title: 'Used Netflix for 52 min', value: 52, unit: 'min', tier: 2, meta: { app: 'Netflix', pkg: 'com.netflix.mediaclient' } }), netflix(1, 20, 3, 52)];
    expect(byDay(signalsFrom(android, k, k, st()))[k]).toMatchObject({ funMin: 52, screenMin: 52 });
    // On the TV, with nothing on a device: it all counts.
    expect(byDay(signalsFrom([netflix(1, 20, 2, 50)], k, k, st()))[k].funMin).toBe(50);
  });

  it("splits a Mac browser's time by that browser's visits only", () => {
    const chrome = (m: number, n: number) => ev({ id: `mac:chrome:${n}`, source: 'mac', kind: 'visit', at: T(k, 15, m), title: 'YouTube', url: 'https://www.youtube.com/watch?v=x', tier: 3, meta: { browser: 'chrome', device: 'mac', site: 'youtube.com' } });
    const d = byDay(signalsFrom([macApp(k, 15, 0, 40, 'Safari', 'com.apple.Safari'), macVisit(k, 15, 5, 'github.com', 1), chrome(10, 2), chrome(20, 3), chrome(30, 4)], k, k, st()))[k];
    expect(d).toMatchObject({ focusMin: 40, funMin: 0, screenMin: 40 });
  });

  it("doesn't count a drive or a flight after midnight as time on a screen", () => {
    const drive = ev({ id: 'maps:motion:automotive:1', source: 'maps', kind: 'trip', at: T(k, 0, 10, 0), end: T(k, 0, 55, 0), title: 'Drove for 45 min', tier: 2, meta: { mode: 'automotive' } });
    const flight = ev({ id: 'maps:motion:automotive:2', source: 'maps', kind: 'trip', at: T('2026-10-13', 23, 0, 0), end: T(k, 6, 30, 0), title: 'Travelled for 7 h 30 min', tier: 2 });
    const run = ev({ id: 'health:workout:night', source: 'health', kind: 'workout', at: T(k, 0, 15, 0), end: T(k, 0, 45, 0), title: 'Running, 30 min', value: 30, unit: 'min', tier: 2 });
    expect(byDay(signalsFrom([drive, run], k, k, st()))[k].lateMin).toBe(0);
    expect(byDay(signalsFrom([flight], k, k, st()))[k].lateMin).toBe(0);
    // Instagram on the phone at 01:00 still is.
    const insta = ev({ id: 'android:app:x:1', source: 'android', kind: 'app', at: T(k, 1, 0, 0), title: 'Used Instagram for 20 min', value: 20, unit: 'min', tier: 2, meta: { app: 'Instagram', pkg: 'com.instagram.android' } });
    expect(byDay(signalsFrom([drive, insta], k, k, st()))[k].lateMin).toBe(20);
  });

  it("knows home from a Shortcut's 'Arrived at Home', its Wi-Fi, and an iPhone visit a few metres off", () => {
    const visit = (n: number, from: number, to: number, lat: number, lon: number, title = 'At Home') => ev({ id: `maps:visit:${n}`, source: 'maps', kind: 'place', at: from, end: to, title, tier: 3, meta: { lat, lon } });
    const evs = [
      visit(1, T('2026-10-12', 19), T('2026-10-13', 8), 51.50041, -0.10041),
      visit(2, T('2026-10-13', 18, 30), T(k, 8, 5), 51.50038, -0.10044),
      // Home all day: the visit lands just over the line between two map squares.
      visit(3, T(k, 8, 40), T(k, 23, 50), 51.50052, -0.10037),
      ev({ id: 'shortcut:a1', source: 'shortcut', kind: 'place', at: T(k, 18, 2), title: 'Arrived at Home', tier: 3, meta: { via: 'arrived' } }),
      ev({ id: 'shortcut:w1', source: 'shortcut', kind: 'place', at: T(k, 18, 3), title: 'Wi-Fi: SKY-4F2A', tier: 3, meta: { via: 'wifi' } }),
    ];
    expect(byDay(signalsFrom(evs, k, k, st()))[k]).toMatchObject({ places: 0, outside: false });
    // The gym, 1 km away, is somewhere.
    expect(byDay(signalsFrom([...evs, visit(4, T(k, 7), T(k, 8), 51.509, -0.1, 'At the gym')], k, k, st()))[k]).toMatchObject({ places: 1, outside: true });
  });
});
