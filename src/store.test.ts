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

  it("doesn't ask for quests from before they existed, or from paused goals", async () => {
    const { S } = await withSpanish();
    expect(S.covered('2026-10-01')).toBe(false); // nothing asked, but nothing done either
    S.tick('q1', { done: true, amount: 30 }, '2026-10-07');
    S.setGoalStatus('g1', 'paused');
    expect(S.questsFor()).toEqual([]);
    expect(S.covered('2026-10-07')).toBe(true); // something was done
    expect(S.covered('2026-10-06')).toBe(false);
  });

  it("doesn't grow the streak on days nothing was done (no workout plan, or only weekly quests)", async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'People', category: 'relationships', quests: [{ id: 'w1', title: 'Reach out', schedule: { kind: 'weekly', times: 3 }, created: '2026-09-14' }] });
    expect(S.currentStreak()).toBe(0);
    expect(S.bestStreak()).toBe(0);
    // A week whose target was met counts whole, days off included.
    for (const k of ['2026-09-21', '2026-09-23', '2026-09-25']) S.tick('w1', { done: true }, k);
    expect(S.covered('2026-09-22')).toBe(true);
    expect(S.covered('2026-09-27')).toBe(true);
    expect(S.covered('2026-09-28')).toBe(false);
    expect(S.bestStreak()).toBe(7);
  });

  it("keeps the streak when the workout plan is turned on, and doesn't inflate it when turned off", async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-10-01' }] });
    for (let d = 1; d <= 7; d++) S.tick('q1', { done: true }, `2026-10-0${d}`);
    expect(S.currentStreak()).toBe(7);
    S.saveGoal({ id: 'g2', title: 'Get fit', category: 'fitness', workouts: true });
    expect(S.currentStreak()).toBe(7);
    expect(S.bestStreak()).toBe(7);

    const T = await fresh();
    T.importData({ sessions: [{ id: 's1', workout: 'a', date: '2026-06-01', started: 1, finished: 2, easy: false, items: [] }, { id: 's2', workout: 'b', date: '2026-10-07', started: 1, finished: 2, easy: false, items: [] }] });
    expect(T.currentStreak()).toBe(1);
    T.setGoalStatus('fitness', 'paused');
    expect(T.currentStreak()).toBe(1);
    expect(T.bestStreak()).toBe(1);
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

describe('XP', () => {
  it('caps workouts at two a day from 2.0 on, and leaves older history as it was', async () => {
    const at = (id: string, date: string, finished: number) => ({ ...session(id, date), finished });
    const before = Date.UTC(2026, 8, 1);
    const after = Date.UTC(2026, 10, 2);
    const S = await fresh({ sessions: [at('o1', '2026-09-01', before), at('o2', '2026-09-01', before), at('o3', '2026-09-01', before)] });
    const old = S.totalXP();
    const one = old / 3;
    expect(old).toBeGreaterThan(0);
    const T = await fresh({ sessions: [at('n1', '2026-11-02', after), at('n2', '2026-11-02', after), at('n3', '2026-11-02', after)] });
    expect(T.totalXP()).toBe(one * 2);
  });
});

describe('loading a backup', () => {
  it("doesn't bring back a fitness goal deleted on this device", async () => {
    const S = await fresh({ sessions: [session('s1', '2026-10-01')] });
    expect(S.state.goals.map((g) => g.id)).toEqual(['fitness']);
    S.deleteGoal('fitness');
    S.importData({ sessions: [session('old1', '2026-09-01')] }); // a 1.x backup
    expect(S.state.goals).toEqual([]);
    expect(S.state.sessions.map((s) => s.id)).toEqual(['old1', 's1']);
  });
});

describe('streak rules', () => {
  const daily = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    return out;
  };

  it('steps over the days off of a quest on set days', async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Career', category: 'career', quests: [{ id: 'q1', title: 'Deep work', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] }, created: '2026-09-21' }] });
    for (const k of daily('2026-09-21', '2026-10-08')) if (S.dayStatus(k) !== 'off') S.tick('q1', { done: true }, k);
    expect(S.dayStatus('2026-10-04')).toBe('off'); // a Sunday
    expect(S.currentStreak()).toBe(14); // the 14 weekdays, weekends in between don't break it
    expect(S.bestStreak()).toBe(14);
  });

  it("doesn't judge this week's weekly targets before the week is over", async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'People', category: 'relationships', quests: [{ id: 'w1', title: 'Reach out', schedule: { kind: 'weekly', times: 3 }, created: '2026-09-28' }] });
    for (const k of ['2026-09-28', '2026-09-30', '2026-10-02', '2026-10-05', '2026-10-07']) S.tick('w1', { done: true }, k);
    expect(S.dayStatus('2026-10-06')).toBe('off'); // 2 of 3 this week: still on track
    expect(S.dayStatus('2026-10-03')).toBe('done'); // last week's target was met
    expect(S.currentStreak()).toBe(9); // last week (7) + the two days ticked this week
  });

  it('keeps the streak when the plan is paused and resumed, even with workouts long before', async () => {
    const session2 = (id: string, date: string) => ({ ...session(id, date), finished: Date.UTC(2026, 5, 1) });
    const S = await fresh({ sessions: [session2('s1', '2026-06-01'), session2('s2', '2026-06-03'), session2('s3', '2026-08-31')] });
    vi.setSystemTime(new Date(2026, 8, 1, 12));
    S.setGoalStatus('fitness', 'paused');
    S.saveGoal({ id: 'g2', title: 'Flexibility', category: 'health', quests: [{ id: 'q1', title: 'Stretch', schedule: { kind: 'daily' }, created: '2026-09-01' }] });
    for (const k of daily('2026-09-01', '2026-10-07')) S.tick('q1', { done: true }, k);
    vi.setSystemTime(new Date(2026, 9, 8, 12));
    expect(S.currentStreak()).toBe(38); // the workout on 31 August, then 37 days of stretching
    S.setGoalStatus('fitness', 'active'); // asks for training from today on, not before
    expect(S.currentStreak()).toBe(38);
    expect(S.bestStreak()).toBe(38);
  });

  it("keeps logged rest days counting when the plan is paused", async () => {
    const S = await fresh({ sessions: [session('s1', '2026-10-05'), session('s2', '2026-10-07')], rests: ['2026-10-06'] });
    expect(S.currentStreak()).toBe(3);
    S.setGoalStatus('fitness', 'paused');
    expect(S.currentStreak()).toBe(3);
  });

  it('asks a new plan user for training today, so ticking a quest alone doesn\'t clear the day', async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Get fit', category: 'fitness', workouts: true, quests: [{ id: 'q1', title: 'Walk', schedule: { kind: 'daily' }, created: '2026-10-08' }] });
    S.tick('q1', { done: true });
    expect(S.trainingCovered('2026-10-08')).toBe(false);
    expect(S.covered('2026-10-08')).toBe(false);
  });

  it("doesn't make up a fitness goal again after the Player deletes their only goal", async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning' });
    S.saveProfile({ goal: 'Learn Spanish', onboarded: true });
    S.deleteGoal('g1');
    const again = await fresh(JSON.parse(localStorage.getItem('pit-data-v1')!));
    expect(again.state.goals).toEqual([]);
  });
});

describe('loading a backup (goals)', () => {
  it('brings back a real goal deleted on this device', async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning' });
    const backup = JSON.parse(S.snapshot());
    S.saveGoal({ id: 'g2', title: 'Save money', category: 'money' });
    S.deleteGoal('g1');
    S.importData(backup);
    expect(S.state.goals.map((g) => g.id).sort()).toEqual(['g1', 'g2']);
    expect(S.state.stamps.goals.g1).toBeGreaterThan(0);
  });
});

describe('the workout plan switched on and off', () => {
  const at = (id: string, date: string) => ({ ...session(id.replace(/-/g, ''), date), finished: Date.UTC(2026, 5, 1) });
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    return out;
  };
  // A weekly-split user from 1.x: trains every planned day, Thursdays are rest days.
  const weeklyUser = () => fresh({ settings: { template: 'weekly' }, sessions: days('2026-09-01', '2026-10-07').filter((k) => new Date(`${k}T12:00`).getDay() !== 4).map((k) => at(`s${k}`, k)) });

  it('keeps every past day as it was after a pause and resume, planned rest days included', async () => {
    const S = await weeklyUser();
    expect(S.dayStatus('2026-09-10')).toBe('done'); // a Thursday: planned rest
    expect([S.currentStreak(), S.bestStreak()]).toEqual([38, 38]); // today is a planned rest day too
    S.setGoalStatus('fitness', 'paused');
    expect([S.currentStreak(), S.bestStreak()]).toEqual([37, 37]); // paused, today asks nothing
    S.setGoalStatus('fitness', 'active');
    expect([S.currentStreak(), S.bestStreak()]).toEqual([38, 38]);
    expect(S.consistency()).toBe(100);
  });

  it('judges a real pause without the plan, and the days around it with it', async () => {
    const S = await fresh({ settings: { template: 'weekly' }, sessions: days('2026-09-01', '2026-09-19').filter((k) => new Date(`${k}T12:00`).getDay() !== 4).map((k) => at(`s${k}`, k)) });
    vi.setSystemTime(new Date(2026, 8, 20, 12));
    S.setGoalStatus('fitness', 'paused'); // travelling: no training, a daily walk instead
    S.saveGoal({ id: 'g2', title: 'Walk', category: 'health', quests: [{ id: 'q1', title: 'Walk', schedule: { kind: 'daily' }, created: '2026-09-20' }] });
    for (const k of days('2026-09-20', '2026-10-07')) S.tick('q1', { done: true }, k);
    vi.setSystemTime(new Date(2026, 8, 27, 12));
    S.setGoalStatus('fitness', 'active');
    for (const k of days('2026-09-27', '2026-10-07')) if (new Date(`${k}T12:00`).getDay() !== 4) S.importData({ sessions: [at(`t${k}`, k)] });
    vi.setSystemTime(new Date(2026, 9, 8, 12));
    expect(S.dayStatus('2026-09-10')).toBe('done'); // planned rest before the pause
    expect(S.dayStatus('2026-09-22')).toBe('done'); // paused: the walk was enough
    expect(S.dayStatus('2026-10-01')).toBe('done'); // planned rest after it
    expect(S.currentStreak()).toBe(37);
  });

  it("doesn't forgive missed training after a pause and resume", async () => {
    const S = await fresh({ sessions: days('2026-09-01', '2026-10-07').filter((k) => k !== '2026-10-05').map((k) => at(`s${k}`, k)) });
    const before = [S.currentStreak(), S.bestStreak(), S.consistency()];
    expect(before[0]).toBe(2);
    S.setGoalStatus('fitness', 'paused');
    S.setGoalStatus('fitness', 'active');
    expect([S.currentStreak(), S.bestStreak(), S.consistency()]).toEqual(before);
    expect(S.dayStatus('2026-10-05')).toBe('missed');
  });

  it('keeps the history when the plan moves to a new goal, or its goal is deleted', async () => {
    const S = await weeklyUser();
    S.saveGoal({ id: 'g2', title: 'Physique', category: 'fitness', workouts: true });
    expect(S.state.goals.filter((g) => g.workouts).map((g) => g.id)).toEqual(['g2']);
    expect([S.currentStreak(), S.bestStreak()]).toEqual([38, 38]);
    S.deleteGoal('g2');
    expect(S.workoutsOn()).toBe(false);
    expect(S.dayStatus('2026-09-10')).toBe('done');
    expect(S.bestStreak()).toBe(37);
  });

  it("doesn't let an old backup's workouts rewrite a quest streak", async () => {
    const S = await fresh();
    S.saveGoal({ id: 'g1', title: 'Learn Spanish', category: 'learning', quests: [{ id: 'q1', title: 'Study', schedule: { kind: 'daily' }, created: '2026-09-01' }] });
    for (const k of days('2026-09-01', '2026-10-07')) S.tick('q1', { done: true }, k);
    const before = [S.currentStreak(), S.bestStreak()];
    S.importData({ sessions: [at('o1', '2026-09-29'), at('o2', '2026-09-30')] }); // a 1.x backup
    expect(S.workoutsOn()).toBe(true);
    expect([S.currentStreak(), S.bestStreak()]).toEqual(before);
  });
});

describe('loading a 1.x backup right after the intro', () => {
  const weekly = () => {
    const out: ReturnType<typeof session>[] = [];
    for (let d = new Date('2026-09-01T12:00'); d <= new Date('2026-10-03T12:00'); d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 4) continue; // Thursdays are the plan's rest day
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push(session(`o${k.replace(/-/g, '')}`, k));
    }
    return { settings: { template: 'weekly' }, sessions: out };
  };

  it("keeps the backup's workout history as it was (the device's own days only start today)", async () => {
    const alone = await fresh(weekly());
    const best = alone.bestStreak();
    const S = await fresh({ settings: { template: 'weekly' } }); // (a device keeps its own plan settings)
    S.saveGoal({ id: 'g1', title: 'Read more', category: 'learning', quests: [{ id: 'q1', title: 'Read', schedule: { kind: 'daily' }, created: '2026-10-08' }] });
    S.importData(weekly());
    expect(S.workoutsOn()).toBe(true);
    expect(S.bestStreak()).toBe(best);
    expect(S.dayStatus('2026-09-10')).toBe('done'); // a Thursday: the plan's rest day
  });

  it('keeps it too when the intro was a day earlier, and the days since follow this device', async () => {
    const alone = await fresh(weekly());
    const best = alone.bestStreak();
    vi.setSystemTime(new Date(2026, 9, 7, 20));
    const S = await fresh({ settings: { template: 'weekly' } });
    S.saveGoal({ id: 'g1', title: 'Walk', category: 'health', quests: [{ id: 'q1', title: 'Walk', schedule: { kind: 'daily' }, created: '2026-10-07' }] });
    S.tick('q1', { done: true }, '2026-10-07');
    vi.setSystemTime(new Date(2026, 9, 8, 12));
    S.importData(weekly());
    expect(S.bestStreak()).toBe(best);
    expect(S.dayStatus('2026-10-07')).toBe('done'); // the walk, with no plan that day
  });
});
