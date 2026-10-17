// @vitest-environment jsdom
// The Player's days as rows for the patterns: their check-in from Arise and what the life log
// holds, each with the tier it came from, without counting anything twice.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const ev = (e: Partial<LifeEvent> & Pick<LifeEvent, 'id' | 'source' | 'kind' | 'at'>): LifeEvent => ({ title: 'Something', tier: 2, ...e });

// A fresh log (in memory) and app data.
async function load(data: object = {}, events: LifeEvent[] = []) {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  const L = await import('./log');
  if (events.length) expect(await L.addEvents(events)).toBe(events.length);
  const S = await import('../store');
  const { dayRows } = await import('./rows');
  const rows = async (from = '2026-10-10', to = '2026-10-16') => Object.fromEntries((await dayRows(from, to)).map((r) => [r.day, r]));
  return { L, S, rows };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
});

describe('a row for each day', () => {
  it("skips Arise's own check-ins, questions to the coach, goals and workouts in the log", async () => {
    const { rows } = await load({}, [
      ev({ id: 'arise:journal:2026-10-14', source: 'arise', kind: 'mood', at: T('2026-10-14', 21), title: 'Mood 2/5', value: 2, unit: 'mood (1-5)', tier: 1 }),
      ev({ id: 'arise:chat:1', source: 'arise', kind: 'message', at: T('2026-10-14', 9), title: 'Asked the coach: why am I tired?', tier: 1 }),
      ev({ id: 'arise:goal:g1', source: 'arise', kind: 'event', at: T('2026-10-14', 9), end: T('2026-10-14', 11), title: 'New goal: Run a 10k', tier: 1 }),
      ev({ id: 'arise:workout:s1', source: 'arise', kind: 'workout', at: T('2026-10-14', 7), end: T('2026-10-14', 8), title: 'A · Back & biceps', tier: 1 }),
    ]);
    const r = (await rows())['2026-10-14'];
    expect(r).toMatchObject({ day: '2026-10-14', trained: false });
    expect(r.mood).toBeUndefined();
    expect(r.people).toBeUndefined();
    expect(r.calMin).toBeUndefined();
  });

  it('takes the sleep that ended that morning, even from the evening before, and not a nap', async () => {
    const { rows } = await load({}, [
      ev({ id: 'health:sleep:1', source: 'health', kind: 'sleep', at: T('2026-10-09', 23), end: T('2026-10-10', 7), title: 'Slept 8 h', value: 480, unit: 'min', tier: 3 }),
      ev({ id: 'health:sleep:2', source: 'health', kind: 'sleep', at: T('2026-10-13', 23), end: T('2026-10-14', 6, 10), title: 'Slept 7 h 10 min', value: 430, unit: 'min', tier: 3 }),
      ev({ id: 'health:nap:3', source: 'health', kind: 'sleep', at: T('2026-10-15', 13), end: T('2026-10-15', 16), title: 'Napped 3 h', value: 180, unit: 'min', tier: 3 }),
      ev({ id: 'health:sleep:4', source: 'health', kind: 'sleep', at: T('2026-10-16', 4), end: T('2026-10-16', 6), title: 'Slept 2 h', value: 120, unit: 'min', tier: 3 }),
    ]);
    const r = await rows();
    expect(r['2026-10-10']).toMatchObject({ sleepMin: 480, tier: { sleepMin: 3 } });
    expect(r['2026-10-14']).toMatchObject({ sleepMin: 430 });
    expect(r['2026-10-13'].sleepMin).toBeUndefined(); // it ended the next morning
    expect(r['2026-10-15'].sleepMin).toBeUndefined();
    expect(r['2026-10-16'].sleepMin).toBeUndefined();
  });

  it('takes the steps of the source that counted most, not the sum of all of them', async () => {
    const { rows } = await load({}, [
      ev({ id: 'health:steps:1', source: 'health', kind: 'steps', at: T('2026-10-12', 0), title: '4,000 steps', value: 4000, unit: 'steps' }),
      ev({ id: 'health:steps:2', source: 'health', kind: 'steps', at: T('2026-10-12', 18), title: '2,500 steps', value: 2500, unit: 'steps' }),
      ev({ id: 'android:steps:1', source: 'android', kind: 'steps', at: T('2026-10-12', 0), title: '5,000 steps', value: 5000, unit: 'steps' }),
    ]);
    const r = await rows();
    expect(r['2026-10-12']).toMatchObject({ steps: 6500, tier: { steps: 2 } });
    expect(r['2026-10-11'].steps).toBeUndefined();
  });

  it("counts calls and messages with someone, but not emails, and only once there's such a source", async () => {
    const email = ev({ id: 'email:m1', source: 'email', kind: 'message', at: T('2026-10-11', 9), title: 'Email from the bank', tier: 3 });
    let r = await (await load({}, [email])).rows();
    expect(r['2026-10-11'].people).toBeUndefined();
    expect(r['2026-10-12'].people).toBeUndefined();

    r = await (await load({}, [email, ev({ id: 'whatsapp:m1', source: 'whatsapp', kind: 'message', at: T('2026-10-12', 20), title: 'Message from Sam', tier: 3 })])).rows();
    expect(r['2026-10-11']).toMatchObject({ people: false });
    expect(r['2026-10-12']).toMatchObject({ people: true, tier: { people: 3 } });
  });

  it("counts time in the calendar, but not all-day events, and only once there's a calendar", async () => {
    let r = await (await load()).rows();
    expect(r['2026-10-13'].calMin).toBeUndefined();
    r = await (
      await load({}, [
        ev({ id: 'calendar:1', source: 'calendar', kind: 'event', at: T('2026-10-13', 0), end: T('2026-10-14', 0), title: 'Holiday', meta: { allDay: true } }),
        ev({ id: 'calendar:2', source: 'calendar', kind: 'event', at: T('2026-10-15', 10), end: T('2026-10-15', 11, 30), title: 'Dentist' }),
        ev({ id: 'calendar:3', source: 'calendar', kind: 'event', at: T('2026-10-15', 23), end: T('2026-10-16', 1), title: 'Late shift' }),
      ])
    ).rows();
    expect(r['2026-10-13']).toMatchObject({ calMin: 0, tier: { calMin: 2 } });
    expect(r['2026-10-15']).toMatchObject({ calMin: 150 }); // 90 minutes and the first hour of the shift
    expect(r['2026-10-16']).toMatchObject({ calMin: 60 });
  });

  it("takes the mood from the check-in, else one added to the day, else Apple's State of Mind", async () => {
    const { rows } = await load({ logs: { '2026-10-10': { m: 4, e: 3, s: 2, at: 1 } } }, [
      ev({ id: 'manual:a', source: 'manual', kind: 'mood', at: T('2026-10-10', 9), title: 'Mood: Meh', value: 2, unit: 'mood (1-5)' }),
      ev({ id: 'manual:b', source: 'manual', kind: 'mood', at: T('2026-10-11', 9), title: 'Mood: Meh', value: 2, unit: 'mood (1-5)' }),
      ev({ id: 'health:mood:1', source: 'health', kind: 'mood', at: T('2026-10-11', 18), title: 'Felt happy', value: 0.9, tier: 3, meta: { valence: 0.9 } }),
      ev({ id: 'health:mood:2', source: 'health', kind: 'mood', at: T('2026-10-12', 18), title: 'Felt drained', value: -0.6, tier: 3, meta: { valence: -0.6 } }),
    ]);
    const r = await rows();
    expect(r['2026-10-10']).toMatchObject({ e: 3, s: 2, mood: 4, tier: { mood: 1 } });
    expect(r['2026-10-11']).toMatchObject({ mood: 2, tier: { mood: 2 } });
    expect(r['2026-10-12']).toMatchObject({ mood: 2, tier: { mood: 3 } });
    expect(r['2026-10-13'].mood).toBeUndefined();
  });

  it('counts workouts from Arise and from other apps, and the quests due and done', async () => {
    const session = { id: 's1', workout: 'a', date: '2026-10-13', started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] };
    const { S, rows } = await load({ sessions: [session] }, [ev({ id: 'health:workout:w1', source: 'health', kind: 'workout', at: T('2026-10-15', 18), end: T('2026-10-15', 19), title: 'Running, 60 min' })]);
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [
      { id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-12' },
      { id: 'q2', title: 'Class', schedule: { kind: 'days', days: [1] }, created: '2026-10-01' }, // Tuesdays
      { id: 'q3', title: 'Read', schedule: { kind: 'weekly', times: 3 }, created: '2026-10-01' },
    ] });
    S.tick('q1', { done: true }, '2026-10-13');
    S.tick('q2', { done: true }, '2026-10-13');
    S.tick('q3', { done: true }, '2026-10-14');
    const r = await rows();
    expect(r['2026-10-13']).toMatchObject({ trained: true, tier: { trained: 1 }, due: 2, done: 2 });
    expect(r['2026-10-14']).toMatchObject({ trained: false, due: 1, done: 0 });
    expect(r['2026-10-15']).toMatchObject({ trained: true, tier: { trained: 2 } });
    expect(r['2026-10-11'].due).toBeUndefined(); // before Study was made
  });

  it("fills only Arise's own fields without a life log", async () => {
    const { rows } = await load({ logs: { '2026-10-12': { e: 4, at: 1 } } }, [ev({ id: 'health:steps:1', source: 'health', kind: 'steps', at: T('2026-10-12', 0), title: '4,000 steps', value: 4000, unit: 'steps' })]);
    (await import('./store-port')).setLifeStore(null);
    const r = await rows();
    expect(r['2026-10-12']).toMatchObject({ e: 4, trained: false });
    expect(r['2026-10-12'].steps).toBeUndefined();
  });
});
