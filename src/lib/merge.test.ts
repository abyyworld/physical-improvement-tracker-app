import { describe, expect, it } from 'vitest';
import { merge, type CloudCopy } from './merge';
import { cleanState, type Settings } from './validate';

const DEFAULTS: Settings = { restBig: 120, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00', aiDaily: true, template: 'ab', perWeek: 5, notify: false, evening: true, eveningAt: '20:30', aiProvider: '', aiModel: '', aiBase: '', aiEngine: '', bar: 'home' };
const NOW = Date.UTC(2026, 9, 8);

const copy = (raw: Record<string, unknown> = {}): CloudCopy => {
  const { active: _a, updatedAt: _u, ...rest } = cleanState(raw, DEFAULTS);
  return rest;
};
const session = (id: string, date = '2026-10-01', started = 1) => ({ id, workout: 'a', date, started, finished: started + 1, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

describe('merging two devices', () => {
  it('keeps workouts added on either device', () => {
    const a = copy({ sessions: [session('s1'), session('s2', '2026-10-02')] });
    const b = copy({ sessions: [session('s1'), session('s3', '2026-10-03')] });
    expect(merge(a, 2, b, 1, NOW).sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it("doesn't bring back a workout deleted on one device (the audit's resurrection bug)", () => {
    const a = copy({ sessions: [session('s1')], stamps: { sessions: { s2: -(NOW - 1000) } } });
    const b = copy({ sessions: [session('s1'), session('s2')], football: ['2026-10-05'] });
    expect(merge(a, 1, b, 2, NOW).sessions.map((s) => s.id)).toEqual(['s1']);
    expect(merge(b, 2, a, 1, NOW).sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('lets a later re-add win over an earlier removal (football toggled off, then on again)', () => {
    const a = copy({ football: ['2026-10-01'], stamps: { football: { '2026-10-01': NOW - 100 } } });
    const b = copy({ football: [], stamps: { football: { '2026-10-01': -(NOW - 500) } } });
    expect(merge(a, 1, b, 2, NOW).football).toEqual(['2026-10-01']);
    expect(merge(b, 2, a, 1, NOW).football).toEqual(['2026-10-01']);
  });

  it('removes a rest day cancelled on one device even if the other changed something else', () => {
    const a = copy({ rests: [], stamps: { rests: { '2026-10-04': -(NOW - 100) } } });
    const b = copy({ rests: ['2026-10-04'], logs: { '2026-10-05': { t: 'hi', at: NOW - 50 } } });
    const m = merge(a, 1, b, 2, NOW);
    expect(m.rests).toEqual([]);
    expect(m.logs['2026-10-05'].t).toBe('hi');
  });

  it('keeps both numbers from same-day weigh-ins on two devices', () => {
    const a = copy({ body: { entries: [{ date: '2026-10-01', weight: 75, at: NOW - 100 }] } });
    const b = copy({ body: { entries: [{ date: '2026-10-01', waist: 80, at: NOW - 50 }] } });
    expect(merge(a, 1, b, 2, NOW).body.entries).toEqual([{ date: '2026-10-01', weight: 75, waist: 80, shoulders: null, at: NOW - 50 }]);
  });

  it('keeps the latest edit of each daily log entry', () => {
    const a = copy({ logs: { '2026-10-01': { t: 'old', at: 1 }, '2026-10-02': { t: 'mine', at: 9 } } });
    const b = copy({ logs: { '2026-10-01': { t: 'new', at: 5 } } });
    const m = merge(a, 9, b, 1, NOW);
    expect(m.logs['2026-10-01'].t).toBe('new');
    expect(m.logs['2026-10-02'].t).toBe('mine');
  });

  const plan = { mode: 'rotation', order: ['x'], workouts: { x: { name: 'X', tag: '', legs: false, slots: [{ ex: 'band_row', sets: 3, min: 8, max: 12 }] } } };

  it("keeps a plan applied on one device when the other device's newer copy has none", () => {
    const a = copy({ customPlan: plan, stamps: { plan: { custom: NOW - 1000 } } });
    const b = copy({ logs: { '2026-10-01': { t: 'x', at: NOW } } });
    expect(merge(a, 1, b, 2, NOW).customPlan?.order).toEqual(['x']);
  });

  it('drops the plan when it was reset after it was applied', () => {
    const a = copy({ customPlan: plan, stamps: { plan: { custom: NOW - 1000 } } });
    const b = copy({ customPlan: null, stamps: { plan: { custom: -(NOW - 10) } } });
    expect(merge(a, 2, b, 1, NOW).customPlan).toBeNull();
  });

  it('keeps coach messages from both devices, but not ones from before a clear', () => {
    const a = copy({ ai: { chat: [{ role: 'user', text: 'old', at: NOW - 40 }, { role: 'user', text: 'a', at: NOW - 20 }] } });
    const b = copy({ ai: { chat: [{ role: 'user', text: 'b', at: NOW - 10 }] }, stamps: { chat: { cleared: NOW - 30 } } });
    expect(merge(a, 1, b, 2, NOW).ai.chat.map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('takes the profile with the later edit, whichever copy is newer overall', () => {
    const a = copy({ profile: { goal: 'first', updated: 100 } });
    const b = copy({ profile: { goal: 'second', updated: 200 } });
    expect(merge(a, 5, b, 1, NOW).profile?.goal).toBe('second');
  });

  it('takes settings from the copy that changed last', () => {
    const a = copy({ settings: { restBig: 90 } });
    const b = copy({ settings: { restBig: 105 } });
    expect(merge(a, 1, b, 2, NOW).settings.restBig).toBe(105);
    expect(merge(a, 3, b, 2, NOW).settings.restBig).toBe(90);
  });

  it('forgets very old stamps on both sides together', () => {
    const old = NOW - 500 * 86400 * 1000;
    const a = copy({ stamps: { football: { '2025-01-01': -old, '2026-10-01': NOW - 5 } }, football: ['2026-10-01'] });
    const m = merge(a, 1, copy(), 0, NOW);
    expect(m.stamps.football).toEqual({ '2026-10-01': NOW - 5 });
  });

  const goal = (id: string, updated: number, title = 'Learn Spanish') => ({ id, title, category: 'learning', updated, quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }] });

  it('keeps goals from both devices, the later edit of each, and not a deleted one', () => {
    const a = copy({ goals: [goal('g1', 10, 'Old title'), goal('g2', 5)] });
    const b = copy({ goals: [goal('g1', 20, 'New title'), goal('g3', 5)], stamps: { goals: { g2: -(NOW - 10) } } });
    const m = merge(a, 1, b, 2, NOW);
    expect(m.goals.map((g) => [g.id, g.title])).toEqual([
      ['g1', 'New title'],
      ['g3', 'Learn Spanish'],
    ]);
  });

  it('merges ticks one by one: both devices tick different quests, and an untick carries over', () => {
    const a = copy({ checks: { '2026-10-01': { q1: { done: true, at: 10 }, q2: { done: true, at: 10 } } } });
    const b = copy({ checks: { '2026-10-01': { q2: { done: false, at: 20 }, q3: { done: true, amount: 30, at: 15 } } } });
    const c = merge(a, 2, b, 1, NOW).checks['2026-10-01'];
    expect(c).toEqual({ q1: { done: true, at: 10 }, q2: { done: false, at: 20 }, q3: { done: true, amount: 30, at: 15 } });
  });

  it('merges measure values by day, the later one winning', () => {
    const a = copy({ values: { m1: { '2026-10-01': { v: 100, at: 5 }, '2026-10-02': { v: 120, at: 5 } } } });
    const b = copy({ values: { m1: { '2026-10-01': { v: 110, at: 9 } } } });
    expect(merge(a, 2, b, 1, NOW).values.m1).toEqual({ '2026-10-01': { v: 110, at: 9 }, '2026-10-02': { v: 120, at: 5 } });
  });
});
