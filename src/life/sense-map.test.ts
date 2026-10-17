// What the iPhone app reads, turned into life events: stable ids (reading twice adds nothing),
// the right tier, sleep merged per night, trips cut from motion, and the Shortcuts inbox.
// Times are built in local time, like the iPhone's own days.

import { describe, expect, it } from 'vitest';
import * as M from './sense-map';

const at = (d: number, h = 0, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026
const iso = (ms: number) => new Date(ms).toISOString();

describe('days', () => {
  it('uses the local calendar day', () => {
    expect(M.dayKey(at(16, 23, 59))).toBe('2026-10-16');
    expect(M.dayKey(at(17, 0, 1))).toBe('2026-10-17');
    expect(M.nextDay('2026-10-31')).toBe('2026-11-01');
    expect(M.nextDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(M.dayStart('2026-10-17')).toBe(at(17));
  });

  it("only counts a day once it's been over for 12 hours, for late syncs", () => {
    expect(M.settledThrough(at(17, 11, 59))).toBe('2026-10-15');
    expect(M.settledThrough(at(17, 12, 1))).toBe('2026-10-16');
  });
});

describe('Apple Health daily totals', () => {
  const bucket = (d: number, value: number) => ({ startDate: iso(at(d)), endDate: iso(at(d + 1)), value, values: {}, unit: 'count' });

  it('makes one movement event a day (tier 2) and one body event (tier 3), with stable ids', () => {
    const events = M.dayEvents(
      {
        steps: [bucket(15, 8214.4), bucket(16, 3000)],
        distance: [bucket(15, 6120)],
        energy: [bucket(15, 420.6)],
        restingHr: [bucket(15, 57.6)],
        weight: [bucket(16, 72.44)],
        hrv: [
          { startDate: iso(at(15, 3)), endDate: iso(at(15, 3)), value: 40 },
          { startDate: iso(at(15, 9)), endDate: iso(at(15, 9)), value: 50 },
        ],
        mindful: [
          { startDate: iso(at(16, 7)), endDate: iso(at(16, 7, 10)), value: 10 },
          { startDate: iso(at(16, 21)), endDate: iso(at(16, 21, 5)), value: 5 },
        ],
      },
      '2026-10-15',
      '2026-10-16',
    );
    const byId = Object.fromEntries(events.map((e) => [e.id, e]));
    expect(byId['health:day:2026-10-15']).toMatchObject({ source: 'health', kind: 'steps', tier: 2, at: at(15), end: at(16), title: '8,214 steps, 6.1 km on foot', detail: '421 active kcal', value: 8214, unit: 'steps' });
    expect(byId['health:day:2026-10-15'].meta).toEqual({ steps: 8214, km: 6.1, activeKcal: 421 });
    expect(byId['health:body:2026-10-15']).toMatchObject({ kind: 'health', tier: 3, title: 'Resting heart rate 58 bpm, HRV 45 ms' });
    expect(byId['health:body:2026-10-16']).toMatchObject({ title: 'Weight 72.4 kg', tier: 3 });
    expect(byId['health:mindful:2026-10-16']).toMatchObject({ title: '15 mindful minutes', value: 15, tier: 2 });
    expect(byId['health:day:2026-10-16'].title).toBe('3,000 steps');
  });

  it('leaves out days outside the range and days with nothing', () => {
    const events = M.dayEvents({ steps: [bucket(14, 100), bucket(15, 0), bucket(16, 200)] }, '2026-10-15', '2026-10-15');
    expect(events).toEqual([]);
  });

  it('skips what it cannot read', () => {
    expect(M.dayEvents({ steps: [null, 'x', { startDate: 'soon', value: 5 }, { startDate: iso(at(15)), value: 'many' }] }, '2026-10-01', '2026-10-31')).toEqual([]);
  });
});

describe('Apple Health sleep', () => {
  const piece = (s: number, e: number, sleepState: string, sourceId = 'com.apple.health.watch') => ({ startDate: iso(s), endDate: iso(e), value: (e - s) / 60000, sleepState, sourceId });
  const now = at(17, 12);

  it('joins the pieces of a night into one event, counting time asleep once across devices', () => {
    const samples = [
      piece(at(16, 23), at(17, 7), 'inBed', 'com.apple.health.phone'),
      // The watch: stages, with a short wake in the middle.
      piece(at(16, 23, 30), at(17, 1), 'light'),
      piece(at(17, 1), at(17, 2), 'deep'),
      piece(at(17, 2), at(17, 2, 20), 'awake'),
      piece(at(17, 2, 20), at(17, 4), 'rem'),
      piece(at(17, 4), at(17, 6, 30), 'light'),
      // A ring, recording the same night at the same time.
      piece(at(16, 23, 40), at(17, 6, 20), 'asleep', 'com.ouraring.oura'),
    ];
    const [night, ...rest] = M.sleepEvents(samples, now);
    expect(rest).toEqual([]);
    // Asleep 23:30 to 6:30, less the 20 minutes awake: 6 h 40 min, not doubled by the ring.
    expect(night).toMatchObject({ id: 'health:sleep:2026-10-17', source: 'health', kind: 'sleep', tier: 2, at: at(16, 23, 30), end: at(17, 6, 30), title: 'Slept 6 h 40 min', value: 400, unit: 'min' });
    expect(night.detail).toBe('Deep 1 h, REM 1 h 40 min, core 4 h, awake 20 min');
    expect(night.meta).toEqual({ deepMin: 60, remMin: 100, coreMin: 240, awakeMin: 20 });
  });

  it("fills in from another device where the main one has nothing (the watch came off)", () => {
    const samples = [
      piece(at(16, 23), at(17, 1), 'light'),
      piece(at(17, 1), at(17, 2), 'deep'),
      // No watch from 2:00 to 4:00. The ring was there all night.
      piece(at(17, 4), at(17, 6), 'rem'),
      piece(at(16, 23, 30), at(17, 6, 30), 'asleep', 'com.ouraring.oura'),
    ];
    const [night] = M.sleepEvents(samples, now);
    // Watch 5 h, plus the ring's 2:00 to 4:00 and 6:00 to 6:30.
    expect(night).toMatchObject({ title: 'Slept 7 h 30 min', at: at(16, 23), end: at(17, 6, 30) });
  });

  it("keeps a nap apart, and waits until a sleep is over", () => {
    const samples = [piece(at(16, 0, 30), at(16, 7), 'asleep'), piece(at(16, 14), at(16, 14, 40), 'asleep'), piece(at(17, 9), at(17, 10, 30), 'asleep')];
    const events = M.sleepEvents(samples, now);
    expect(events.map((e) => [e.id, e.title])).toEqual([
      ['health:sleep:2026-10-16', 'Slept 6 h 30 min'],
      [`health:nap:${Math.round(at(16, 14) / 60000)}`, 'Napped 40 min'],
    ]);
    // The morning sleep ended only 1.5 hours ago: not yet.
    expect(M.sleepEvents(samples, at(17, 13, 31)).map((e) => e.id)).toContain(`health:nap:${Math.round(at(17, 9) / 60000)}`);
  });

  it('reads the same night the same way again', () => {
    const samples = [piece(at(16, 0, 30), at(16, 7), 'asleep')];
    expect(M.sleepEvents(samples, now)).toEqual(M.sleepEvents([...samples, ...samples], now));
  });
});

describe('Apple Health workouts', () => {
  it("uses Health's own id, and says what it was", () => {
    const [run, other] = M.workoutEvents([
      { workoutType: 'running', duration: 1860, totalDistance: 5230, totalEnergyBurned: 401.2, startDate: iso(at(16, 7)), endDate: iso(at(16, 7, 31)), sourceName: 'Strava', platformId: 'ABC-123' },
      { workoutType: 'traditionalStrengthTraining', duration: 2700, startDate: iso(at(16, 18)), endDate: iso(at(16, 18, 45)) },
    ]);
    expect(run).toMatchObject({ id: 'health:workout:ABC-123', source: 'health', kind: 'workout', tier: 2, title: 'Running, 31 min, 5.2 km', detail: '401 active kcal', value: 31, unit: 'min' });
    expect(run.meta).toEqual({ type: 'running', km: 5.2, kcal: 401, app: 'Strava' });
    expect(other).toMatchObject({ id: `health:workout:traditionalStrengthTraining:${Math.round(at(16, 18) / 60000)}`, title: 'Strength training, 45 min' });
    expect(M.workoutName('highIntensityIntervalTraining')).toBe('HIIT');
    expect(M.workoutName('functionalStrengthTraining')).toBe('Functional strength training');
  });
});

describe('Apple Health moods', () => {
  it("names HealthKit's numbers, and keeps moods at tier 3", () => {
    const [moment, day] = M.moodEvents([
      { id: 'M1', at: at(16, 9), kind: 1, valence: 0.42, feeling: 6, labels: [7, 15], about: [17, 5] },
      { id: 'M2', at: at(16, 21), kind: 2, valence: -0.3, feeling: 3, labels: [], about: [] },
    ]);
    expect(moment).toMatchObject({ id: 'health:mood:M1', source: 'health', kind: 'mood', tier: 3, title: 'Felt calm and grateful', detail: 'Pleasant, about work and family', value: 0.42 });
    expect(day).toMatchObject({ id: 'health:mood:M2', title: 'Mood of the day: slightly unpleasant', tier: 3 });
    expect(day.detail).toBeUndefined();
  });
});

describe('motion', () => {
  const e = (t: number, k: string, c = 2) => ({ t, k, c });

  it('cuts walks, rides and trips out of what iOS noticed, and keeps the last one open', () => {
    const entries = M.motionEntries([
      e(at(16, 8), 'still'),
      e(at(16, 8, 10), 'walk'),
      e(at(16, 8, 20), 'walk', 0), // not sure: more of the same
      e(at(16, 8, 30), 'drive'),
      e(at(16, 8, 40), 'still'), // a red light: still the same trip
      e(at(16, 8, 41), 'drive'),
      e(at(16, 9, 5), 'walk'),
      e(at(16, 9, 7), 'still'), // a 2-minute walk is too short to note
      e(at(16, 12), 'run'),
    ]);
    const { events, cursor } = M.motionTrips(entries, at(16, 12, 20));
    expect(events.map((x) => [x.id, x.title, x.at, x.end])).toEqual([
      [`maps:motion:walk:${Math.round(at(16, 8, 10) / 60000)}`, 'Walked 20 min', at(16, 8, 10), at(16, 8, 30)],
      [`maps:motion:drive:${Math.round(at(16, 8, 30) / 60000)}`, 'In a vehicle for 35 min', at(16, 8, 30), at(16, 9, 5)],
    ]);
    expect(events[0]).toMatchObject({ source: 'maps', kind: 'trip', tier: 2, value: 20, unit: 'min', meta: { mode: 'walk' } });
    // The run may still be going on: read again from its start next time.
    expect(cursor).toBe(at(16, 12));
  });

  it('gives a trip the same id when it is read again from the cursor', () => {
    const first = M.motionTrips(M.motionEntries([e(at(16, 8), 'still'), e(at(16, 8, 10), 'cycle')]), at(16, 8, 30));
    expect(first.events).toEqual([]);
    const second = M.motionTrips(M.motionEntries([e(first.cursor!, 'cycle'), e(at(16, 8, 50), 'still')]), at(16, 9, 30));
    expect(second.events.map((x) => x.id)).toEqual([`maps:motion:cycle:${Math.round(at(16, 8, 10) / 60000)}`]);
    expect(second.events[0].title).toBe('Cycled 40 min');
  });

  it('waits when the trip only just stopped', () => {
    const { events, cursor } = M.motionTrips(M.motionEntries([e(at(16, 8), 'drive'), e(at(16, 8, 30), 'still')]), at(16, 8, 32));
    expect(events).toEqual([]);
    expect(cursor).toBe(at(16, 8));
  });

  it('has nothing to say about nothing', () => {
    expect(M.motionTrips([], at(16))).toEqual({ events: [], cursor: null });
    expect(M.motionEntries([null, { t: 'x' }, { t: at(16), k: 'teleport', c: 9 }])).toEqual([{ t: at(16), k: 'unknown', c: 2 }]);
  });
});

describe('calendar', () => {
  it("adds events that are over, but not Arise's own, birthdays or holidays", () => {
    const now = at(17, 12);
    const events = M.calendarEvents(
      [
        { id: 'E1', title: ' Dentist ', start: at(16, 9), end: at(16, 10), allDay: false, calendar: 'Home', type: 1, place: '5 Main St' },
        { id: 'E1', title: 'Standup', start: at(17, 9), end: at(17, 9, 15), calendar: 'Work', type: 2 }, // a repeat: another day, another id
        { id: 'E2', title: 'Later', start: at(17, 15), end: at(17, 16), type: 1 },
        { id: 'E3', title: 'Leg day', start: at(16, 18), end: at(16, 19), type: 1, arise: true },
        { id: 'E4', title: "Sam's birthday", start: at(16), end: at(17), allDay: true, type: 4 },
        { id: 'E5', title: '', start: at(15, 9), end: at(15, 10), type: 0 },
      ],
      now,
    );
    expect(events.map((x) => [x.id, x.title])).toEqual([
      [`calendar:E1:${Math.round(at(16, 9) / 60000)}`, 'Dentist'],
      [`calendar:E1:${Math.round(at(17, 9) / 60000)}`, 'Standup'],
      [`calendar:E5:${Math.round(at(15, 9) / 60000)}`, 'Busy'],
    ]);
    expect(events[0]).toMatchObject({ source: 'calendar', kind: 'event', tier: 2, detail: '5 Main St', meta: { calendar: 'Home' } });
  });
});

describe('the Shortcuts and places inbox', () => {
  const log = (id: string, t: number, kind: string, what = '', detail = '') => ({ type: 'log', id, at: t, kind, what, detail });
  const lines = (...xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');

  it('reads one object per line and skips anything that looks wrong', () => {
    const items = M.parseInbox(
      lines(
        log('A1', at(16, 9), 'message', 'Sam: see you at 7'),
        '{not json',
        '',
        log('../etc', at(16, 9), 'other', 'bad id'),
        log('A2', at(16, 9), 'teleported', 'odd kind'),
        { type: 'visit', id: 'V1', lat: 51.5007, lon: -0.1246, arrive: at(16, 10), depart: at(16, 11), acc: 30 },
        { type: 'visit', id: 'V2', lat: 91, lon: 0, arrive: at(16, 10) },
        { type: 'visit', id: 'V3', lat: 1, lon: 1 },
        { type: 'sms', id: 'X' },
      ),
    );
    expect(items).toEqual([
      { type: 'log', id: 'A1', at: at(16, 9), kind: 'message', what: 'Sam: see you at 7', detail: '' },
      { type: 'log', id: 'A2', at: at(16, 9), kind: 'other', what: 'odd kind', detail: '' },
      { type: 'visit', id: 'V1', lat: 51.5007, lon: -0.1246, arrive: at(16, 10), depart: at(16, 11) },
    ]);
  });

  it('turns automations into events with the right kind and tier', () => {
    const items = M.parseInbox(
      lines(
        log('A1', at(16, 9), 'message', 'Sam: see you at 7'),
        log('A2', at(16, 9, 5), 'arrived', 'Gym'),
        log('A3', at(16, 9, 6), 'charging', ''),
        log('A4', at(16, 9, 7), 'focus', 'Work on', 'from the Shortcuts app'),
        log('A5', at(16, 9, 8), 'email', 'x'.repeat(200)),
      ),
    );
    const { events, held } = M.sortInbox(items, [], at(17));
    expect(held).toEqual([]);
    expect(events.map((x) => [x.id, x.source, x.kind, x.tier, x.title])).toEqual([
      ['shortcut:A1', 'shortcut', 'message', 3, 'Message: Sam: see you at 7'],
      ['shortcut:A2', 'shortcut', 'place', 3, 'Arrived at Gym'],
      ['shortcut:A3', 'shortcut', 'other', 2, 'Charger'],
      ['shortcut:A4', 'shortcut', 'other', 2, 'Focus: Work on'],
      ['shortcut:A5', 'shortcut', 'message', 3, `Email: ${'x'.repeat(119)}…`],
    ]);
    expect(events[3].detail).toBe('from the Shortcuts app');
    expect(events[4].detail).toBe('x'.repeat(200)); // the whole thing is kept
  });

  it('puts an app opened and closed together as time in the app', () => {
    const items = M.parseInbox(lines(log('O1', at(16, 9), 'appOpened', 'Instagram'), log('C1', at(16, 9, 12), 'appClosed', 'instagram '), log('C2', at(16, 10), 'appClosed', 'TikTok')));
    const { events } = M.sortInbox(items, [], at(17));
    expect(events.map((x) => [x.id, x.kind, x.title, x.end])).toEqual([
      ['shortcut:O1', 'app', 'Used Instagram for 12 min', at(16, 9, 12)],
      ['shortcut:C2', 'app', 'Closed TikTok', undefined],
    ]);
    expect(events[0]).toMatchObject({ tier: 2, value: 12, unit: 'min', meta: { app: 'Instagram' } });
  });

  it("holds an app that's still open, and pairs it when it closes", () => {
    const open = M.parseInbox(lines(log('O1', at(16, 9), 'appOpened', 'YouTube')));
    const first = M.sortInbox(open, [], at(16, 9, 30));
    expect(first.events).toEqual([]);
    expect(first.held.map((x) => x.id)).toEqual(['O1']);
    // Taken again (the app closed before clearing the inbox): still only once.
    const second = M.sortInbox([...open, ...M.parseInbox(lines(log('C1', at(16, 10), 'appClosed', 'YouTube')))], first.held, at(16, 11));
    expect(second.events.map((x) => x.title)).toEqual(['Used YouTube for 1 h']);
    expect(second.held).toEqual([]);
    // Never closed: after 12 hours it's just "Opened".
    expect(M.sortInbox([], first.held, at(17)).events.map((x) => x.title)).toEqual(['Opened YouTube']);
  });

  it("waits for a place to be left, then uses the full visit", () => {
    const arrived = { type: 'visit' as const, id: 'V1', lat: 51.5, lon: -0.12, arrive: at(16, 9) };
    const first = M.sortInbox([arrived], [], at(16, 10));
    expect(first.visits).toEqual([]);
    expect(first.held).toEqual([arrived]);
    const left = { ...arrived, id: 'V2', depart: at(16, 11) };
    const second = M.sortInbox([left], first.held, at(16, 12));
    expect(second.visits).toEqual([left]);
    expect(second.held).toEqual([]);
    // A later visit means it was left, even if iOS never said so.
    const third = M.sortInbox([{ type: 'visit', id: 'V3', lat: 51.6, lon: -0.1, arrive: at(16, 13) }], first.held, at(16, 14));
    expect(third.visits.map((v) => v.id)).toEqual(['V1']);
    expect(third.held.map((v) => v.id)).toEqual(['V3']);
  });

  it('names a visit and keeps it at tier 3', () => {
    const v = { type: 'visit' as const, id: 'V1', lat: 51.500729, lon: -0.124625, arrive: at(16, 9), depart: at(16, 10, 30) };
    const place = M.cleanPlace({ name: 'Gym One', street: 'Main St', city: 'London', junk: 1 });
    expect(M.visitEvent(v, place)).toEqual({
      id: `maps:visit:${Math.round(at(16, 9) / 1000)}`,
      source: 'maps',
      kind: 'place',
      at: at(16, 9),
      end: at(16, 10, 30),
      title: 'At Gym One',
      detail: 'Main St, London',
      value: 90,
      unit: 'min',
      tier: 3,
      meta: { lat: 51.5007, lon: -0.1246 },
    });
    expect(M.visitEvent({ ...v, arrive: undefined }, null)).toMatchObject({ id: `maps:visit:left:${Math.round(at(16, 10, 30) / 1000)}`, title: 'Left a place', at: at(16, 10, 30) });
  });
});
