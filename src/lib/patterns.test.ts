// What Arise noticed: two groups of the Player's own days compared on one outcome, with enough
// days on each side and a clear difference, the stronger of two that measure the same thing, the
// tier of what each was made from, and the exact sentences.

import { describe, expect, it } from 'vitest';
import { findPatterns, lifeAverages, weekNumbers, type DayRow } from './patterns';

const TODAY = '2026-10-17';
// Days in the 6 weeks before today, newest first: 2026-10-16, 2026-10-15...
const day = (i: number) => {
  const d = new Date(2026, 9, 16 - i);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Rows from the given days' fields, one day each.
const rows = (...fields: Partial<DayRow>[]): DayRow[] => fields.map((f, i) => ({ day: day(i), ...f }));
const many = (n: number, f: Partial<DayRow>) => Array.from({ length: n }, () => f);

// 7 workout days with energy 4.1 on average, and 10 without with 3.2.
const WORKOUTS = rows(...[4, 4, 4, 4, 4, 4, 5].map((e) => ({ e, trained: true })), ...[3, 3, 3, 3, 3, 3, 3, 3, 4, 4].map((e) => ({ e, trained: false })));

describe('the patterns in your days', () => {
  it('says what goes with more energy, in plain words with the numbers and how many days', () => {
    const found = findPatterns(WORKOUTS, TODAY);
    expect(found.map((p) => p.text)).toEqual(['Your energy is higher on days you work out: 4.1 vs 3.2 (17 days).']);
    expect(found[0]).toMatchObject({ outcome: 'energy', factor: 'trained', nYes: 7, nNo: 10, tier: 1 });
  });

  it('says how often the quests get finished, as percentages', () => {
    const slept = rows(...many(5, { sleepMin: 450, due: 1 }), ...many(5, { sleepMin: 360, due: 1 })).map((r, i) => ({ ...r, done: [1, 1, 1, 1, 0, 1, 1, 0, 0, 0][i] }));
    expect(findPatterns(slept, TODAY).map((p) => p.text)).toEqual([
      'You finish your quests on 80% of days after 7 hours of sleep or more, and 40% after less sleep.',
      // And, with nothing asked of anyone, how long they sleep the night after.
      'You sleep 50 min more after days you finish your quests (9 days).',
    ]);

    // "on 80% of days you work out", not "of days on days you work out".
    const trained = slept.map((r, i) => ({ day: r.day, due: 1, done: r.done, trained: i < 5 }));
    expect(findPatterns(trained, TODAY).map((p) => p.text)).toEqual(["You finish your quests on 80% of days you work out, and 40% on days you don't."]);
  });

  it('needs at least 4 days on each side', () => {
    const three = rows(...many(3, { e: 5, trained: true }), ...many(10, { e: 2, trained: false }));
    expect(findPatterns(three, TODAY)).toEqual([]);
    const four = rows(...many(4, { e: 5, trained: true }), ...many(10, { e: 2, trained: false }));
    expect(findPatterns(four, TODAY)).toHaveLength(1);
  });

  it('needs a clear difference: 0.4 is too small, 0.5 is enough', () => {
    const small = rows(...many(5, { e: 4, trained: true }), ...[4, 4, 4, 3, 3].map((e) => ({ e, trained: false })));
    expect(findPatterns(small, TODAY)).toEqual([]);
    const enough = rows(...many(4, { e: 4, trained: true }), ...[4, 4, 3, 3].map((e) => ({ e, trained: false })));
    expect(findPatterns(enough, TODAY).map((p) => p.text)).toEqual(['Your energy is higher on days you work out: 4.0 vs 3.5 (8 days).']);
  });

  it("doesn't compare finishing the quests with finishing the quests", () => {
    const quests = rows(...many(6, { due: 2, done: 2 }), ...many(6, { due: 2, done: 1 }));
    expect(findPatterns(quests, TODAY)).toEqual([]);
  });

  it('keeps only the stronger of sleep as logged and sleep as rated', () => {
    // Sleep from the log splits energy by 2 points; sleep as rated by less.
    const both = rows(...[5, 5, 5, 5, 5, 5].map((e, i) => ({ e, sleepMin: 470, s: i < 4 ? 4 : 2 })), ...[3, 3, 3, 3, 3, 3].map((e, i) => ({ e, sleepMin: 300, s: i < 2 ? 4 : 2 })));
    const found = findPatterns(both, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ factor: 'sleep7', text: 'Your energy is higher after 7 hours of sleep or more: 5.0 vs 3.0 (12 days).' });
  });

  it('carries the tier of what it was made from', () => {
    const sleep = rows(...many(5, { e: 4, sleepMin: 480, tier: { sleepMin: 3 } }), ...many(5, { e: 2, sleepMin: 330, tier: { sleepMin: 3 } }));
    expect(findPatterns(sleep, TODAY)[0]).toMatchObject({ factor: 'sleep7', tier: 3 });
    expect(findPatterns(WORKOUTS.map((r) => ({ ...r, tier: { trained: 1 } })), TODAY)[0]).toMatchObject({ factor: 'trained', tier: 1 });
    // A workout another app recorded is everyday activity.
    expect(findPatterns(WORKOUTS.map((r) => ({ ...r, tier: { trained: 2 } })), TODAY)[0].tier).toBe(2);
    // A mood from Apple's State of Mind is sensitive.
    const mood = rows(...many(5, { mood: 4, trained: true, tier: { mood: 3 } }), ...many(5, { mood: 2, trained: false, tier: { mood: 3 } }));
    expect(findPatterns(mood, TODAY)[0]).toMatchObject({ outcome: 'mood', tier: 3, text: 'Your mood is higher on days you work out: 4.0 vs 2.0 (10 days).' });
  });

  it('rounds the steps it compares at to 500', () => {
    const walks = rows(...[9000, 9100, 9200, 9300, 9400].map((steps) => ({ e: 4, steps })), ...[5000, 5100, 5200, 5300, 5400].map((steps) => ({ e: 2, steps })));
    // The middle of those is 7,200 steps.
    expect(findPatterns(walks, TODAY).map((p) => p.text)).toEqual(['Your energy is higher on days you walk 7,000 steps or more: 4.0 vs 2.0 (10 days).']);
  });

  it('leaves out today and anything older than 6 weeks, and keeps the top 5', () => {
    const today = { ...WORKOUTS[0], day: TODAY };
    const old = (r: DayRow, i: number) => ({ ...r, day: `2026-08-${String(10 + i).padStart(2, '0')}` });
    expect(findPatterns([today, ...WORKOUTS.slice(1)], TODAY)[0].nYes).toBe(6);
    expect(findPatterns(WORKOUTS.map(old), TODAY)).toEqual([]);

    const busy = rows(
      ...many(6, { e: 5, mood: 5, trained: true, people: true, sleepMin: 480, steps: 9000, screenMin: 60, calMin: 300 }),
      ...many(6, { e: 2, mood: 2, trained: false, people: false, sleepMin: 300, steps: 2000, screenMin: 400, calMin: 30 }),
    );
    expect(findPatterns(busy, TODAY)).toHaveLength(5);
  });

  it('phrases screen time and busy days with their own thresholds', () => {
    const screens = rows(...many(5, { e: 4, screenMin: 100 }), ...many(5, { e: 2, screenMin: 200 }));
    expect(findPatterns(screens, TODAY).map((p) => p.text)).toEqual(['Your energy is higher on days with under 2 h 30 min on screens: 4.0 vs 2.0 (10 days).']);
    const calendar = rows(...many(5, { e: 2, calMin: 420 }), ...many(5, { e: 4, calMin: 60 }));
    expect(findPatterns(calendar, TODAY).map((p) => p.text)).toEqual(['Your energy is lower on days with 4 h or more in your calendar: 2.0 vs 4.0 (10 days).']);
    const people = rows(...many(5, { mood: 4, people: true }), ...many(5, { mood: 3, people: false }));
    expect(findPatterns(people, TODAY)[0]).toMatchObject({ text: "Your mood is higher on days you're in touch with someone (calls or messages): 4.0 vs 3.0 (10 days).", tier: 3 });
  });
});

describe('patterns that need nothing typed', () => {
  // Days that alternate, oldest last: odd days one way, even days the other.
  const alt = (n: number, odd: Partial<DayRow>, even: Partial<DayRow>) => rows(...Array.from({ length: n }, (_, i) => (i % 2 ? odd : even)));

  it('says how long they sleep the night after, from the next morning\'s row', () => {
    // After each workout day the night is 8 hours; after the others 7.
    const days = alt(12, { trained: true, sleepMin: 420 }, { trained: false, sleepMin: 480 });
    const found = findPatterns([{ day: TODAY, sleepMin: 420 }, ...days], TODAY);
    expect(found.map((p) => p.text)).toEqual(['You sleep 1 h more after days you work out (12 days).']);
    expect(found[0]).toMatchObject({ outcome: 'sleepMin', factor: 'trained', yes: 480, no: 420, nYes: 6, nNo: 6, tier: 3 });
  });

  it('takes a late night and the sleep of that same night together', () => {
    const days = alt(12, { lateMin: 60, sleepMin: 380 }, { lateMin: 0, sleepMin: 440 });
    const found = findPatterns([{ day: TODAY, lateMin: 0, sleepMin: 440 }, ...days], TODAY);
    expect(found.map((p) => p.text)).toEqual(["You sleep 1 h less on nights you're on your phone or computer past midnight (12 days)."]);
    expect(found[0]).toMatchObject({ outcome: 'sleepMin', factor: 'late', nYes: 5, nNo: 7, tier: 3 });
  });

  it('says how much more they focus, and with how many people they are in touch', () => {
    const walks = rows(...many(9, { steps: 8000, focusMin: 200, tier: { focusMin: 2 } }), ...many(9, { steps: 4000, focusMin: 120, tier: { focusMin: 2 } }));
    const focus = findPatterns(walks, TODAY);
    expect(focus.map((p) => p.text)).toEqual(['You focus 1 h 20 min more on days you walk 6,000 steps or more (18 days).']);
    expect(focus[0]).toMatchObject({ outcome: 'focusMin', factor: 'steps', tier: 2 });

    const people = findPatterns(alt(12, { trained: true, peopleN: 3 }, { trained: false, peopleN: 1 }), TODAY);
    expect(people.map((p) => p.text)).toEqual(["You're in touch with more people on days you work out: 3.0 vs 1.0 a day (12 days)."]);
    expect(people[0]).toMatchObject({ outcome: 'people', tier: 3 }); // made from calls and messages
  });

  it('finds what goes with late nights, social feeds and fun', () => {
    expect(findPatterns(alt(10, { lateMin: 45, e: 2 }, { lateMin: 0, e: 4 }), TODAY).map((p) => p.text)).toEqual(['Your energy is lower after nights on your phone or computer past midnight: 2.0 vs 4.0 (10 days).']);
    expect(findPatterns(alt(10, { socialMin: 90, e: 2 }, { socialMin: 10, e: 4 }), TODAY).map((p) => p.text)).toEqual(['Your energy is lower on days with 45 min or more on social feeds: 2.0 vs 4.0 (10 days).']);
    const fun = findPatterns(alt(10, { funMin: 120, mood: 4 }, { funMin: 20, mood: 3 }), TODAY);
    expect(fun.map((p) => p.text)).toEqual(['Your mood is higher on days with over an hour of videos, games or music: 4.0 vs 3.0 (10 days).']);
    expect(fun[0]).toMatchObject({ factor: 'fun', tier: 3 });
  });

  it("doesn't compare a thing with itself or with what it's part of", () => {
    // Focus is part of screen time, the people in touch are being in touch, sleep is sleep.
    expect(findPatterns(alt(12, { screenMin: 400, focusMin: 240 }, { screenMin: 100, focusMin: 30 }), TODAY)).toEqual([]);
    expect(findPatterns(alt(12, { people: true, peopleN: 3 }, { people: false, peopleN: 0 }), TODAY)).toEqual([]);
    expect(findPatterns([{ day: TODAY, sleepMin: 480 }, ...alt(12, { sleepMin: 480, s: 5 }, { sleepMin: 360, s: 1 })], TODAY)).toEqual([]);
  });

  it('needs a clear difference: 25 minutes of sleep is too little to name', () => {
    expect(findPatterns([{ day: TODAY, sleepMin: 420 }, ...alt(12, { trained: true, sleepMin: 420 }, { trained: false, sleepMin: 435 })], TODAY)).toEqual([]);
  });
});

describe('the life log on average', () => {
  it('gives only the parts with data', () => {
    expect(lifeAverages(rows({ e: 4 }, { e: 3 }))).toEqual([]);
    const month = rows(...many(3, { sleepMin: 430, steps: 7380, people: true, screenMin: 185 }), ...many(2, { people: false }));
    expect(lifeAverages(month)).toEqual(['you slept 7 h 10 min a night on average (3 nights)', 'walked 7,400 steps a day (3 days)', 'were in touch with someone on 3 of 5 days', 'spent 3 h 10 min a day on screens (3 days)']);
  });
});

describe('the last 7 days in numbers', () => {
  it('counts sleep and check-ins up to today, and steps, people and screens up to yesterday', () => {
    const week: DayRow[] = [
      { day: TODAY, e: 5, s: 5, mood: 4, sleepMin: 400, steps: 300, people: false, screenMin: 20 }, // steps and screens still adding up
      ...rows({ e: 3, s: 2, mood: 3.5, sleepMin: 460, steps: 8040, people: true, screenMin: 125 }, { steps: 6000, people: false }, {}, {}, {}, { e: 4, people: true }),
      // 10 October: too early for last night and the check-ins, the 7th day before today for the rest.
      { day: day(6), e: 1, s: 1, sleepMin: 300, steps: 20000, people: true, screenMin: 600 },
      { day: day(7), e: 1, steps: 1, people: true }, // too early for all of them
    ];
    expect(weekNumbers(week, TODAY)).toEqual({
      sleepMin: { avg: 430, n: 2 },
      energy: { avg: 4, n: 3 },
      mood: { avg: 3.8, n: 2 },
      steps: { avg: 11300, n: 3 },
      people: { avg: 3, n: 4 },
      screenMin: { avg: 360, n: 2 },
    });
  });

  it('gives how they slept only without a recorded night, and nothing without data', () => {
    expect(weekNumbers(rows({ s: 4, e: 2 }, { s: 3 }), TODAY)).toEqual({ sleepFelt: { avg: 3.5, n: 2 }, energy: { avg: 2, n: 1 } });
    expect(weekNumbers(rows({}, { trained: true }), TODAY)).toEqual({});
  });
});
