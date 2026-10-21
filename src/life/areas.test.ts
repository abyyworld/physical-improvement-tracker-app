// How each part of life is going, from the Player's days with nothing rated: the last week
// against their own last 28 days (3 is like usual), with the plain limits where the number itself
// matters, "not enough to go on" when it isn't there, their own rating next to it, and the words
// for today, the week and the coach, each only for an AI that may read it.

import { describe, expect, it } from 'vitest';
import { lifeAreas, seenToday, signalsText, sourcesText, weekCompare } from './areas';
import { addDays } from './dates';
import type { DaySignals, SignalField, SourceWord } from './signals';
import type { LifeTier } from './types';

const TODAY = '2026-10-17'; // a Saturday
const ago = (i: number) => addDays(TODAY, -i);

type Fields = Partial<Omit<DaySignals, 'day' | 'tier' | 'from'>>;
// What each value's tier and source are kept under.
const FIELD: Partial<Record<keyof Fields, SignalField | null>> = { due: 'quests', done: 'quests', questsBy: 'quests', sleepFrom: null, spentUnit: null, top: null, s: null, e: null, m: null, talked: null };

// The days from 34 days ago to today, built up a field at a time.
class Days {
  private map = new Map<string, DaySignals>();
  add(days: (i: number) => Fields | null, tier: LifeTier, from: SourceWord[]) {
    for (let i = 34; i >= 0; i--) {
      const f = days(i);
      if (!f) continue;
      const k = ago(i);
      const s = this.map.get(k) || { day: k, tier: {}, from: {} };
      Object.assign(s, f);
      for (const key of Object.keys(f) as (keyof Fields)[]) {
        const field = key in FIELD ? FIELD[key] : (key as SignalField);
        if (!field) continue;
        s.tier[field] = tier;
        s.from[field] = from;
      }
      this.map.set(k, s);
    }
    return this;
  }
  get list() {
    return [...this.map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }
}
const area = (days: Days, id: string, life?: NonNullable<Parameters<typeof lifeAreas>[2]>['life']) => lifeAreas(days.list, TODAY, { life }).find((a) => a.id === id)!;

describe('sleep', () => {
  it('compares the last 7 nights with the usual, and says "about" when worked out from the devices', () => {
    const days = new Days().add((i) => ({ sleepMin: i <= 6 ? 400 : 440, sleepFrom: 'inferred', bedtime: i <= 6 ? -10 : -20 }), 3, ['Mac']);
    expect(area(days, 'sleep')).toEqual({
      id: 'sleep',
      label: 'Sleep',
      score: 2,
      reason: 'About 6 h 40 min a night, 30 min less than usual (Mac).',
      trend: 'down',
      tier: 3,
      sources: ['Mac'],
    });
  });

  it('is never better than 2 under 6 hours a night, however usual that is', () => {
    const days = new Days().add(() => ({ sleepMin: 330, sleepFrom: 'health' }), 3, ['phone']);
    expect(area(days, 'sleep')).toMatchObject({ score: 2, trend: 'same', reason: '5 h 30 min a night, like usual (phone).' });
  });

  it('says when bedtimes moved around', () => {
    const days = new Days().add((i) => ({ sleepMin: 450, sleepFrom: 'health', bedtime: i <= 6 ? [-120, 30, -60, 90, -90, 60, 0][i] : -30 }), 3, ['phone']);
    expect(area(days, 'sleep')).toMatchObject({ score: 2, trend: 'down', reason: '7 h 30 min a night, like usual; bedtimes moved around (phone).' });
  });

  it('needs 4 of the last 7 nights and 10 of the last 28', () => {
    const three = new Days().add((i) => (i <= 6 && i >= 3 ? null : { sleepMin: 420 }), 3, ['phone']);
    expect(area(three, 'sleep')).toEqual({ id: 'sleep', label: 'Sleep', score: null, reason: 'Not enough to go on yet.', trend: null, tier: 1, sources: [], help: 'Connect your phone (Health) or your Mac, and Arise works out your sleep.' });
    const fresh = new Days().add((i) => (i <= 8 ? { sleepMin: 420 } : null), 3, ['phone']);
    expect(area(fresh, 'sleep').score).toBeNull();
    const enough = new Days().add((i) => (i <= 9 ? { sleepMin: 420 } : null), 3, ['phone']);
    expect(area(enough, 'sleep').score).toBe(3);
  });
});

describe('body', () => {
  it('weighs steps, workout minutes and workout days against the usual', () => {
    const days = new Days()
      .add((i) => ({ steps: i >= 1 && i <= 7 ? 8200 : 7000 }), 2, ['phone'])
      .add((i) => {
        const trained = i >= 1 && i <= 7 ? [2, 4, 6].includes(i) : i % 3 === 0;
        return { active: trained ? 45 : 0, trained };
      }, 1, ['Arise']);
    expect(area(days, 'body')).toEqual({
      id: 'body',
      label: 'Body and health',
      score: 4,
      reason: '8,200 steps a day, 900 more than usual; 3 days with a workout (phone and Arise).',
      trend: 'up',
      tier: 2,
      sources: ['phone', 'Arise'],
    });
  });

  it('is never better than 2 under 3,000 steps a day', () => {
    const days = new Days().add(() => ({ steps: 2800 }), 2, ['phone']);
    expect(area(days, 'body')).toMatchObject({ score: 2, trend: 'same', reason: '2,800 steps a day, like usual (phone).' });
  });

  it("goes on Arise's workouts alone, as any AI may read those", () => {
    const days = new Days().add((i) => ({ active: i % 2 ? 40 : 0, trained: !!(i % 2) }), 1, ['Arise']);
    expect(area(days, 'body')).toMatchObject({ score: 3, tier: 1, sources: ['Arise'], reason: '4 days with a workout (Arise).' });
  });
});

describe('mind', () => {
  it('counts late nights and social feeds against the usual, and is never better than 2 after 4 late nights in a week', () => {
    const days = new Days()
      .add((i) => ({ lateMin: i <= 6 ? [45, 60, 40, 50, 0, 0, 0][i] : 0 }), 3, ['Mac'])
      .add((i) => (i >= 1 ? { socialMin: i <= 7 ? 70 : 50, screenMin: 300 } : null), 3, ['browser']);
    expect(area(days, 'mind')).toMatchObject({
      score: 2,
      trend: 'down',
      reason: 'Up past midnight on 4 of 7 nights; 1 h 10 min a day on social feeds, 15 min more than usual (Mac and browser).',
      tier: 3,
      sources: ['Mac', 'browser'],
    });
  });

  it('is never better than 2 with late nights most of the week, however usual they are', () => {
    const owl = new Days().add(() => ({ lateMin: 45 }), 3, ['phone']);
    expect(area(owl, 'mind')).toMatchObject({ score: 2, trend: 'same', reason: 'Up past midnight on 7 of 7 nights (phone).' });
  });

  it('uses mood check-ins only when they are there', () => {
    const quiet = new Days().add(() => ({ lateMin: 0 }), 3, ['phone']);
    expect(area(quiet, 'mind')).toMatchObject({ score: 3, reason: 'No late nights (phone).' });
    const moods = new Days().add(() => ({ lateMin: 0 }), 3, ['phone']).add((i) => ({ mood: i <= 6 ? 4.5 : 3 }), 1, ['Arise']);
    expect(area(moods, 'mind')).toMatchObject({ score: 4, trend: 'up', reason: 'No late nights; mood 4.5 of 5 (phone and Arise).' });
  });
});

describe('people', () => {
  it('compares how many people and how many days in touch with the usual', () => {
    const days = new Days().add((i) => ({ people: i >= 1 && i <= 7 ? ([2, 5].includes(i) ? 1 : 0) : 3 }), 3, ['phone']);
    expect(area(days, 'people')).toMatchObject({ score: 1, trend: 'down', tier: 3, reason: 'In touch with 0.3 people a day, on 2 of 7 days, 2 fewer than usual (phone).' });
  });

  it('is never better than 2 with one day in touch in a week, however usual that is', () => {
    const days = new Days().add((i) => ({ people: i === 3 || i % 9 === 0 ? 1 : 0 }), 3, ['Mac']);
    expect(area(days, 'people')).toMatchObject({ score: 2, reason: 'In touch with 0.1 people a day, on 1 of 7 days, like usual (Mac).' });
    const none = new Days().add(() => ({ people: 0 }), 3, ['Mac']);
    expect(area(none, 'people')).toMatchObject({ score: 2, reason: 'No calls or messages with anyone in 7 days (Mac).' });
  });
});

describe('work, money, fun and purpose', () => {
  it('compares focused time on weekdays, with the week\'s meetings', () => {
    const weekday = (i: number) => ![0, 6].includes(new Date(2026, 9, 17 - i).getDay());
    const days = new Days().add((i) => (i >= 1 ? { focusMin: weekday(i) ? (i <= 7 ? 180 : 120) : 10, meetingsMin: weekday(i) ? 60 : 0 } : null), 2, ['Mac']);
    expect(area(days, 'work')).toMatchObject({ score: 5, trend: 'up', tier: 2, reason: '3 h focused a weekday, 45 min more than usual; 5 h in meetings this week (Mac).' });
  });

  it('has nothing to say about money without bank statements or money quests', () => {
    const days = new Days().add(() => ({ steps: 5000, people: 2 }), 3, ['phone']);
    expect(area(days, 'money')).toMatchObject({ score: null, reason: 'Not enough to go on yet.', help: 'Connect your bank statements in Connect.' });
    const bank = new Days().add((i) => (i >= 1 ? { spent: i <= 7 ? 20 : 30, spentUnit: 'GBP' } : null), 3, ['bank statements']);
    expect(area(bank, 'money')).toMatchObject({ score: 4, trend: 'up', tier: 3, reason: 'Spent 20 GBP a day, 27% less than usual (bank statements).' });
  });

  it('counts videos, games and music, and going out at the weekend', () => {
    const days = new Days().add((i) => (i >= 1 ? { funMin: i <= 7 ? 100 : 60 } : null), 2, ['Mac']).add((i) => ({ places: [0, 6].includes(new Date(2026, 9, 17 - i).getDay()) ? (i <= 7 ? 3 : 1) : 0 }), 3, ['phone']);
    expect(area(days, 'fun')).toMatchObject({ score: 5, trend: 'up', tier: 3, reason: '1 h 40 min a day on videos, games and music, on 7 of 7 days; out to 3 places a day at the weekend (phone and Mac).' });
  });

  it('goes on finishing quests for Purpose, and their quests where they want to grow count a little more', () => {
    const days = new Days().add((i) => (i >= 1 ? (i <= 7 && ![3, 6].includes(i) ? { due: 2, done: 2, questsBy: { career: { due: 1, done: 1 }, mind: { due: 1, done: 1 } } } : { due: 2, done: 1, questsBy: { career: { due: 1, done: 1 }, mind: { due: 1, done: 0 } } }) : null), 1, ['Arise']);
    expect(area(days, 'meaning')).toMatchObject({ score: 5, trend: 'up', tier: 1, sources: ['Arise'], reason: 'Finished your quests on 5 of 7 days, 4 days more than usual (Arise).' });
    expect(area(days, 'meaning', { areas: {}, grow: ['mind'] }).score).toBe(5);
    expect(area(new Days().add(() => ({ steps: 5000 }), 2, ['phone']), 'meaning')).toMatchObject({ score: null, help: 'Set a goal with quests, and Arise sees how it goes.' });
  });
});

describe('the eight together', () => {
  it('come in the usual order, with their own rating next to the data, never in its place', () => {
    const days = new Days().add(() => ({ sleepMin: 420, sleepFrom: 'health' }), 3, ['phone']);
    const areas = lifeAreas(days.list, TODAY, { life: { areas: { sleep: 2, money: 4 }, grow: [] } });
    expect(areas.map((a) => a.id)).toEqual(['sleep', 'body', 'mind', 'people', 'work', 'money', 'fun', 'meaning']);
    expect(areas[0]).toMatchObject({ score: 3, said: { score: 2, word: 'Not great' } });
    expect(areas[5]).toMatchObject({ score: null, said: { score: 4, word: 'Good' } });
    expect(areas[1].said).toBeUndefined();
  });

  it('knows nothing with nothing to go on', () => {
    expect(lifeAreas([], TODAY).every((a) => a.score === null && a.trend === null && a.tier === 1)).toBe(true);
  });
});

describe('the words for today and the week', () => {
  const today: DaySignals = {
    day: TODAY,
    sleepMin: 430,
    sleepFrom: 'inferred',
    steps: 6400,
    active: 0,
    focusMin: 135,
    people: 3,
    funMin: 100,
    top: { fun: ['YouTube', 'Steam', 'Spotify'] },
    tier: { sleepMin: 3, steps: 2, active: 2, focusMin: 2, people: 3, funMin: 3 },
    from: { sleepMin: ['Mac'], steps: ['phone'], active: ['phone'], focusMin: ['Mac'], people: ['phone', 'Mac'], funMin: ['Mac', 'browser'] },
  };

  it('gives the chips for what Arise saw today and last night, only what it saw', () => {
    expect(seenToday([today], TODAY)).toEqual([
      { field: 'sleepMin', text: 'Slept about 7 h 10 min', tier: 3, from: ['Mac'] },
      { field: 'steps', text: '6,400 steps', tier: 2, from: ['phone'] },
      { field: 'focusMin', text: '2 h 20 min focused', tier: 2, from: ['Mac'] },
      { field: 'people', text: 'Talked to 3 people', tier: 3, from: ['phone', 'Mac'] },
      { field: 'funMin', text: '1 h 40 min on YouTube and Steam', tier: 3, from: ['Mac', 'browser'] },
    ]);
    expect(seenToday([{ day: TODAY, sleepMin: 400, sleepFrom: 'health', people: 1, funMin: 30, tier: {}, from: {} }], TODAY).map((s) => s.text)).toEqual(['Slept 6 h 40 min', 'Talked to 1 person', '30 min on videos, games and music']);
    expect(seenToday([], TODAY)).toEqual([]);
  });

  it('names the sources the way people say them', () => {
    expect(sourcesText(['Arise', 'browser', 'phone', 'Mac'])).toBe('your phone, Mac, browser and Arise');
    expect(sourcesText(['Mac'])).toBe('your Mac');
    expect(sourcesText(['bank statements', 'phone'])).toBe('your phone and bank statements');
    expect(sourcesText(['imports', 'Arise'])).toBe('what you imported and Arise');
    expect(sourcesText([])).toBe('');
  });

  it('puts the week next to the usual', () => {
    const days = new Days()
      .add((i) => ({ sleepMin: i <= 6 ? 400 : 440, sleepFrom: i === 2 ? 'inferred' : 'health' }), 3, ['phone'])
      .add(() => ({ steps: 7000 }), 2, ['phone'])
      .add((i) => (i <= 6 ? { lateMin: i < 2 ? 45 : 0 } : { lateMin: i % 7 === 0 ? 40 : 0 }), 3, ['Mac']);
    const w = weekCompare(days.list, TODAY);
    expect(w.sleepMin).toEqual({ avg: 400, n: 7, usual: 430, about: true, tier: 3, from: ['phone'] });
    expect(w.steps).toEqual({ avg: 7000, n: 7, usual: 7000, tier: 2, from: ['phone'] });
    // Two late nights of 7; usually one in seven.
    expect(w.lateNights).toEqual({ avg: 2, n: 7, usual: 1.25, tier: 3, from: ['Mac'] });
    expect(w.people).toBeUndefined();
  });
});

describe("the coach's section", () => {
  // A week: sleep from the Mac, steps from the phone, people from messages, focus from app use, quests.
  const days = new Days()
    .add(() => ({ sleepMin: 420, sleepFrom: 'inferred', bedtime: -30, wake: 390 }), 3, ['Mac'])
    .add((i) => ({ steps: 6000 + i * 10 }), 2, ['phone'])
    .add(() => ({ people: 2, calls: 1, messages: 5 }), 3, ['phone'])
    .add(() => ({ focusMin: 120, top: { work: ['Code'] } }), 2, ['Mac'])
    .add((i) => ({ due: 1, done: i % 2 }), 1, ['Arise']);
  const areas = lifeAreas(days.list, TODAY);
  const LEFT_OUT = "Some of what Arise saw uses parts of the life log this AI may not read, so it's left out.";

  it('gives the private AI all of it: a line a day and the areas with why', () => {
    const { text, tier } = signalsText(days.list, areas, 3, { today: TODAY });
    expect(tier).toBe(3);
    const lines = text.split('\n');
    expect(lines[0]).toBe('## What Arise saw (worked out on the device from the life log; nothing typed by them)');
    expect(lines).toContain('- Fri 16 Oct: slept about 7 h (23:30 to 06:30); 6,010 steps; in touch with 2 people (1 call, 5 messages); 2 h focused (Code); quests 1 of 1 done.');
    expect(lines).toContain('- Today so far (Sat 17 Oct): slept about 7 h (23:30 to 06:30); 6,000 steps; in touch with 2 people (1 call, 5 messages); 2 h focused (Code); quests 0 of 1 done.');
    expect(lines.filter((l) => /^- ((Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d|Today)/.test(l))).toHaveLength(7);
    expect(lines).toContain('- Sleep: 3 of 5, like usual. About 7 h a night, like usual (Mac).');
    expect(lines).toContain('- Money: not enough to go on.');
    expect(text).not.toContain(LEFT_OUT);
    expect(text).not.toMatch(/rate|check in|diary/i);
  });

  it("gives an AI that may read only everyday activity no sleep, people or anything else sensitive", () => {
    const { text, tier } = signalsText(days.list, areas, 2, { today: TODAY });
    expect(tier).toBe(2);
    expect(text).toContain('- Fri 16 Oct: 6,010 steps; 2 h focused (Code); quests 1 of 1 done.');
    expect(text).not.toMatch(/slept|in touch|Sleep:|People you love:/);
    expect(text).toContain(LEFT_OUT);
  });

  it("gives an AI that may read only Arise's own data just that", () => {
    const { text, tier } = signalsText(days.list, areas, 1, { today: TODAY });
    expect(tier).toBe(1);
    expect(text).toContain('- Fri 16 Oct: quests 1 of 1 done.');
    expect(text).not.toMatch(/slept|steps|focused|in touch/);
    expect(text).toContain('- Purpose: ');
    expect(text).toContain(LEFT_OUT);
  });

  it('gives a small model the last 3 days and only the areas it knows, without app names', () => {
    const { text } = signalsText(days.list, areas, 3, { today: TODAY, compact: true });
    expect(text.split('\n').filter((l) => /^- ((Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d|Today)/.test(l))).toHaveLength(3);
    expect(text).not.toContain('(Code)');
    expect(text).not.toContain('not enough to go on');
  });

  it('says nothing before any device has told Arise anything', () => {
    const own = new Days().add(() => ({ due: 1, done: 1, trained: false }), 1, ['Arise']);
    expect(signalsText(own.list, lifeAreas(own.list, TODAY), 3, { today: TODAY })).toEqual({ text: '', tier: 1 });
    expect(signalsText([], [], 3)).toEqual({ text: '', tier: 1 });
  });
});

describe('the tier of what an area rests on', () => {
  it('counts the usual it was compared with, not only the last week', () => {
    // Their own mood taps this week (tier 1); Apple's State of Mind the weeks before (tier 2).
    const days = new Days().add((i) => (i <= 6 ? { mood: 3 } : null), 1, ['Arise']).add((i) => (i > 6 ? { mood: 4 } : null), 2, ['phone']);
    const mind = area(days, 'mind');
    expect(mind).toMatchObject({ trend: 'down', tier: 2 });
    // "worse than usual" rests on tier-2 days: not for an AI that may read only tier 1.
    expect(signalsText(days.list, lifeAreas(days.list, TODAY), 1, { today: TODAY }).text).not.toContain('Mood and mind');
    // The same for the week next to the usual.
    const people = new Days().add((i) => (i <= 6 ? { people: 2 } : null), 2, ['phone']).add((i) => (i > 6 ? { people: 3 } : null), 3, ['phone']);
    const week = weekCompare(people.list, TODAY).people!;
    expect(week.usual).toBeGreaterThan(week.avg);
    expect(week.tier).toBe(3);
  });
});
