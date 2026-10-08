// @vitest-environment jsdom
// Goals, quests, streaks and XP in the store.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Store = typeof import('./store');

async function fresh(data?: object): Promise<Store> {
  localStorage.clear();
  if (data) localStorage.setItem('pit-data-v1', JSON.stringify(data));
  vi.resetModules();
  return import('./store');
}

const session = (id: string, date: string) => ({ id, workout: 'a', date, started: 1, finished: 2, easy: false, items: [{ ex: 'band_row', setup: '', sets: [{ r: 10, done: true }] }] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 8, 12)); // Thursday 8 October 2026
});

describe('moving older data onto goals', () => {
  it('turns existing workouts into a fitness goal that uses the workout plan', async () => {
    const S = await fresh({ sessions: [session('s1', '2026-10-01')], profile: { goal: 'V-taper', why: 'confidence', deadline: '1 year', onboarded: true } });
    expect(S.state.goals).toHaveLength(1);
    expect(S.state.goals[0]).toMatchObject({ id: 'fitness', title: 'V-taper', category: 'fitness', why: 'confidence', by: '1 year', workouts: true, created: '2026-10-01' });
    expect(S.workoutsOn()).toBe(true);
  });

  it('leaves a new device without goals, and a deleted fitness goal deleted', async () => {
    expect((await fresh()).state.goals).toEqual([]);
    const S = await fresh({ sessions: [session('s1', '2026-10-01')], stamps: { goals: { fitness: -5 } } });
    expect(S.state.goals).toEqual([]);
    expect(S.workoutsOn()).toBe(false);
  });
});

describe('quests and the streak', () => {
  async function withSpanish() {
    const S = await fresh();
    const g = S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [
      { id: 'q1', title: 'Study', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' }, created: '2026-10-05' },
      { id: 'q2', title: 'Conversation class', schedule: { kind: 'days', days: [1, 3] }, created: '2026-10-05' }, // Tue, Thu
      { id: 'q3', title: 'Practice test', schedule: { kind: 'weekly', times: 2 }, created: '2026-10-05' },
    ] })!;
    return { S, g };
  }

  it("lists today's quests: daily, today's weekday, and weekly ones still open", async () => {
    const { S } = await withSpanish();
    expect(S.questsFor('2026-10-08').map((x) => x.quest.id)).toEqual(['q1', 'q2', 'q3']);
    expect(S.questsFor('2026-10-07').map((x) => x.quest.id)).toEqual(['q1', 'q3']); // Wednesday: no class
    S.tick('q3', { done: true }, '2026-10-06');
    S.tick('q3', { done: true }, '2026-10-07');
    expect(S.questsFor('2026-10-08').map((x) => x.quest.id)).toEqual(['q1', 'q2']); // weekly target met
  });

  it('counts a day for the streak only when every quest due that day is done', async () => {
    const { S } = await withSpanish();
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) S.tick('q1', { done: true, amount: 30 }, d);
    S.tick('q2', { done: true }, '2026-10-06');
    expect(S.covered('2026-10-05')).toBe(true);
    expect(S.covered('2026-10-06')).toBe(true);
    expect(S.currentStreak()).toBe(3); // today isn't over yet, so it doesn't break the streak
    S.tick('q1', { done: true, amount: 30 }, '2026-10-08');
    expect(S.covered('2026-10-08')).toBe(false); // the class is still due today
    S.tick('q2', { done: true }, '2026-10-08');
    expect(S.currentStreak()).toBe(4);
  });

  it('breaks the streak on a missed day, and unticking counts', async () => {
    const { S } = await withSpanish();
    S.tick('q1', { done: true }, '2026-10-05');
    S.tick('q1', { done: true }, '2026-10-07');
    expect(S.currentStreak()).toBe(1);
    S.tick('q1', { done: false }, '2026-10-07');
    expect(S.currentStreak()).toBe(0);
  });

  it('works out each quest’s own streak, by day or by week', async () => {
    const { S, g } = await withSpanish();
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07']) S.tick('q1', { done: true }, d);
    expect(S.questStreak(g.quests[0])).toBe(3);
    S.tick('q3', { done: true }, '2026-09-29');
    expect(S.questStreak(g.quests[2])).toBe(0);
  });

  it('measures consistency against what was due', async () => {
    const { S } = await withSpanish();
    S.tick('q1', { done: true }, '2026-10-05');
    S.tick('q1', { done: true }, '2026-10-06');
    // Due Mon and Tue: q1 twice, q2 on Tue = 3 (Wednesday is "today" here and not done yet, so it
    // doesn't count; this week's weekly quest counts only what's done). Done: 2.
    expect(S.consistency('2026-10-07')).toBe(67);
  });

  it('gives XP for quests and their amounts, milestones and measures', async () => {
    const { S } = await withSpanish();
    const before = S.totalXP();
    S.tick('q1', { done: true, amount: 30 });
    expect(S.totalXP() - before).toBe(15);
    S.tick('q2', { done: true });
    expect(S.totalXP() - before).toBe(25);
    const g = S.saveGoal({ ...S.goalById('g1')!, milestones: [{ id: 'm1', title: 'A2 exam' }], measures: [{ id: 'v1', name: 'Words', unit: '' }] })!;
    S.toggleMilestone(g.id, 'm1');
    S.logValue('v1', 500);
    expect(S.totalXP() - before).toBe(25 + 100 + 5);
    expect(S.stats().int).toBe(10); // 2 ticks: not yet 5
  });

  it("doesn't count quests from before they existed, or from paused goals", async () => {
    const { S } = await withSpanish();
    expect(S.covered('2026-10-01')).toBe(true);
    S.setGoalStatus('g1', 'paused');
    expect(S.questsFor()).toEqual([]);
    expect(S.covered('2026-10-07')).toBe(true);
  });
});

describe('goals', () => {
  it('lets only one goal use the workout plan', async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Physique', category: 'fitness', workouts: true });
    S.saveGoal({ id: 'g2', title: 'Run', category: 'fitness', workouts: true });
    expect(S.state.goals.map((g) => [g.id, !!g.workouts])).toEqual([['g1', false], ['g2', true]]);
  });

  it('remembers a deleted goal as deleted, for sync', async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'X', category: 'other' });
    S.deleteGoal('g1');
    expect(S.state.goals).toEqual([]);
    expect(S.state.stamps.goals.g1).toBeLessThan(0);
  });

  it('training still counts the old way for workout users', async () => {
    const S = await fresh({ sessions: [session('s1', '2026-10-06'), session('s2', '2026-10-07')] });
    expect(S.workoutsOn()).toBe(true);
    expect(S.currentStreak()).toBe(2);
  });
});
