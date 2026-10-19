// @vitest-environment jsdom
// The patterns kept for the coach: only the ones each AI may read, with a line when some were
// left out, nothing at all when there are none, and gone with the data.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEvent } from './types';

const ai = vi.hoisted(() => ({ useInsight: vi.fn(), useSignals: vi.fn() }));
vi.mock('../ai.js', () => ({ useInsight: ai.useInsight, useSignals: ai.useSignals }));

const T = (k: string, h = 12, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, '0')}`);
const session = (date: string) => ({ id: `s${date.replace(/-/g, '')}`, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

// Five good days (energy 4, a workout in Arise, 8 hours of sleep, 9,000 steps) and five hard ones.
const GOOD = days(7, 11);
const HARD = days(12, 16);
const DATA = { sessions: GOOD.map(session), logs: Object.fromEntries([...GOOD.map((k) => [k, { e: 4, at: 1 }]), ...HARD.map((k) => [k, { e: 2, at: 1 }])]) };
const EVENTS: LifeEvent[] = [...GOOD, ...HARD].flatMap((k) => {
  const good = GOOD.includes(k);
  return [
    { id: `health:sleep:${k}`, source: 'health', kind: 'sleep', at: T(k, good ? 0 : 2), end: T(k, good ? 8 : 7), title: 'Slept', value: good ? 480 : 300, unit: 'min', tier: 3 },
    { id: `health:steps:${k}`, source: 'health', kind: 'steps', at: T(k, 0), title: 'Steps', value: good ? 9000 : 3000, unit: 'steps', tier: 2 },
  ] as LifeEvent[];
});

async function load(data: object = {}, events: LifeEvent[] = []) {
  vi.resetModules();
  ai.useInsight.mockClear();
  ai.useSignals.mockClear();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('pit-data-v1', JSON.stringify(data));
  const L = await import('./log');
  if (events.length) await L.addEvents(events);
  const S = await import('../store');
  const INS = await import('./insight');
  INS.initInsight({ delay: -1 });
  return { S, INS };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 17, 10)); // Saturday 17 October 2026
});

const HEAD = "## Patterns Arise found on this device (the Player's own days over the last 6 weeks; what goes together, not proof)";
const LEFT_OUT = "Some patterns use parts of the life log this AI may not read, so they're left out.";
const SLEEP = '- Your energy is higher after 7 hours of sleep or more: 4.0 vs 2.0 (10 days).';
const STEPS = '- Your energy is higher on days you walk 6,000 steps or more: 4.0 vs 2.0 (10 days).';
const WORKOUT = '- Your energy is higher on days you work out: 4.0 vs 2.0 (10 days).';
// How long they sleep the night after, which needs nothing from them: made from sleep, so sensitive.
const NIGHT_STEPS = '- You sleep 2 h 20 min more after days you walk 6,000 steps or more (9 days).';
const NIGHT_WORKOUT = '- You sleep 1 h 50 min more after days you work out (10 days).';

describe('the patterns for the coach', () => {
  it('gives each AI only the patterns it may read, and says when some were left out', async () => {
    const { INS } = await load(DATA, EVENTS);
    expect((await INS.get())!.patterns.map((p) => [p.outcome, p.factor, p.tier])).toEqual([
      ['sleepMin', 'steps', 3],
      ['sleepMin', 'trained', 3],
      ['energy', 'sleep7', 3],
      ['energy', 'steps', 2],
      ['energy', 'trained', 1],
    ]);
    // Only Arise's own data for an AI that may read nothing more (the free AI, by default).
    expect(INS.contextFor(1)).toEqual({ text: [HEAD, WORKOUT, LEFT_OUT].join('\n'), tier: 1 });
    expect(INS.contextFor(2, true)).toEqual({ text: [HEAD, STEPS, WORKOUT, LEFT_OUT].join('\n'), tier: 2 });
    // The private AI, or the one on this device.
    expect(INS.contextFor(3)).toEqual({ text: [HEAD, NIGHT_STEPS, NIGHT_WORKOUT, SLEEP, STEPS, WORKOUT].join('\n'), tier: 3 });
    expect(INS.contextFor(3, true).text).toBe([HEAD, NIGHT_STEPS, NIGHT_WORKOUT].join('\n')); // a small model: the top 2
    // ai.js asks through the hook.
    expect(ai.useInsight).toHaveBeenCalledTimes(1);
    expect(ai.useInsight.mock.calls[0][0](1, false)).toEqual(INS.contextFor(1));
  });

  it('gives nothing when there are no patterns', async () => {
    const { INS } = await load({ logs: { '2026-10-16': { e: 4, at: 1 } } });
    expect(INS.contextFor(3)).toEqual({ text: '', tier: 1 }); // not worked out yet
    expect((await INS.get())!.patterns).toEqual([]);
    expect(INS.contextFor(3)).toEqual({ text: '', tier: 1 });
  });

  it('keeps what Arise saw with them: the days, the eight areas, and the rows they came from', async () => {
    const { INS } = await load(DATA, EVENTS);
    const ins = (await INS.get())!;
    expect(ins.signals).toHaveLength(43); // the 6 weeks before today, and today
    expect(ins.signals.find((d) => d.day === '2026-10-11')).toMatchObject({ sleepMin: 480, sleepFrom: 'health', steps: 9000, trained: true });
    expect(ins.rows.find((r) => r.day === '2026-10-11')).toMatchObject({ sleepMin: 480, steps: 9000, trained: true, e: 4 });
    expect(ins.areas.map((a) => a.id)).toEqual(['sleep', 'body', 'mind', 'people', 'work', 'money', 'fun', 'meaning']);
    expect(ins.areas[0]).toMatchObject({ id: 'sleep', trend: 'down', tier: 3, sources: ['phone'] });
    expect(ins.areas[5]).toMatchObject({ id: 'money', score: null });
  });

  it('gives each AI only the part of what Arise saw that it may read', async () => {
    const { INS } = await load(DATA, EVENTS);
    expect(INS.signalsContextFor(3)).toEqual({ text: '', tier: 1 }); // not worked out yet
    await INS.get();
    const all = INS.signalsContextFor(3);
    expect(all.tier).toBe(3);
    expect(all.text).toContain('## What Arise saw (worked out on the device from the life log; nothing typed by them)');
    expect(all.text).toContain('- Sun 11 Oct: slept 8 h (00:00 to 08:00); 9,000 steps; worked out.');
    expect(all.text).toContain('- Fri 16 Oct: slept 5 h (02:00 to 07:00); 3,000 steps.');
    // Under 6 hours a night is never better than 2.
    expect(all.text).toContain('\n- Sleep: 2 of 5, worse than usual. 5 h 30 min a night, 1 h less than usual (phone).\n');
    expect(all.text).toContain('\n- Body and health: 3 of 5, worse than usual. 4,700 steps a day, 1,300 fewer than usual; 2 days with a workout (phone and Arise).\n');
    expect(all.text).not.toContain("this AI may not read");
    // Steps are everyday activity; sleep is sensitive.
    const two = INS.signalsContextFor(2);
    expect(two.tier).toBe(2);
    expect(two.text).toContain('- Fri 16 Oct: 3,000 steps.');
    expect(two.text).not.toMatch(/slept|Sleep:/);
    expect(two.text).toContain("Some of what Arise saw uses parts of the life log this AI may not read, so it's left out.");
    // Arise's own workouts only, for the free AI by default.
    const one = INS.signalsContextFor(1);
    expect(one.tier).toBe(1);
    expect(one.text).toContain('- Sun 11 Oct: worked out.');
    expect(one.text).not.toMatch(/slept|steps|Sleep:|Body and health:/);
    // ai.js asks through its hook.
    expect(ai.useSignals).toHaveBeenCalledTimes(1);
    expect(ai.useSignals.mock.calls[0][0](2, false)).toEqual(two);
  });

  it("forgets them when another account's data takes this one's place", async () => {
    const { S, INS } = await load(DATA, EVENTS);
    await INS.get();
    expect(INS.contextFor(1).text).not.toBe('');
    S.resetAll();
    expect(INS.peek()).toBeNull();
    expect(INS.contextFor(3).text).toBe('');
    expect(INS.signalsContextFor(3).text).toBe('');
  });
});
