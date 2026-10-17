// What Arise noticed: two groups of the Player's own days compared on one outcome, with enough
// days on each side and a clear difference, the stronger of two that measure the same thing, the
// tier of what each was made from, and the exact sentences.

import { describe, expect, it } from 'vitest';
import { findPatterns, lifeAverages, type DayRow } from './patterns';

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
    expect(findPatterns(slept, TODAY).map((p) => p.text)).toEqual(['You finish your quests on 80% of days after 7 hours of sleep or more, and 40% after less sleep.']);

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

describe('the life log on average', () => {
  it('gives only the parts with data', () => {
    expect(lifeAverages(rows({ e: 4 }, { e: 3 }))).toEqual([]);
    const month = rows(...many(3, { sleepMin: 430, steps: 7380, people: true, screenMin: 185 }), ...many(2, { people: false }));
    expect(lifeAverages(month)).toEqual(['you slept 7 h 10 min a night on average (3 nights)', 'walked 7,400 steps a day (3 days)', 'were in touch with someone on 3 of 5 days', 'spent 3 h 10 min a day on screens (3 days)']);
  });
});
