// The whole person: the life check-in's words, what it says back, the daily check-in, and the
// coach's section on their life.

import { describe, expect, it } from 'vitest';
import * as G from './goals';
import { AREA_IDS, AREA_STEPS, AREAS, GROW_CATEGORY, changesSince, checkinAverages, firstRead, hasCheckin, highest, lifeLines, lowest, shortDate, type Life } from './life-check';

const LIFE: Life = { at: '2026-10-17', areas: { work: 2, people: 5, sleep: 2 }, grow: ['sleep', 'meaning'], values: ['Family', 'Health', 'Faith'], hope: '' };

describe('reading the life check-in', () => {
  it('says back where they are, in order: the low parts, the best one, where to grow, the goal, what matters', () => {
    expect(firstRead(LIFE, 'Speak Spanish')).toEqual([
      'Sleep is rough right now. Almost everything gets easier when sleep does.',
      'Work or study is hard right now.',
      'You have people you love around you.',
      'You want to grow first: Sleep and Purpose.',
      'Your coach will help you fit “Speak Spanish” around the rest of your life, starting with sleep.',
      'What matters most to you: Family, Health, Faith.',
      'Your coach sees all of this, not just one goal. You can change it any time on the You tab.',
    ]);
  });

  it('uses the System look\'s own names when asked', () => {
    const plain = firstRead(LIFE, 'Speak Spanish');
    const system = firstRead(LIFE, 'Speak Spanish', { coach: 'The System', tab: 'Progress' });
    expect(system).toEqual(plain.map((l) => l.replace(/^Your coach/, 'The System').replace('the You tab', 'the Progress tab')));
    expect(system.at(-1)).toBe('The System sees all of this, not just one goal. You can change it any time on the Progress tab.');
    expect(system.join(' ')).not.toMatch(/Your coach|You tab/);
  });

  it("keeps the goal to what's going well when nothing is low, and says nothing with nothing rated", () => {
    expect(firstRead({ areas: { body: 4, fun: 3 } }, ' Run a 5k ')).toEqual([
      'Your body feels good. Worth protecting.',
      'Your coach will help you work toward “Run a 5k” without losing what\'s going well.',
      'Your coach sees all of this, not just one goal. You can change it any time on the You tab.',
    ]);
    expect(firstRead({ areas: {}, grow: [], values: [] }, 'Speak Spanish')).toEqual([]);
    expect(firstRead(null, 'Speak Spanish')).toEqual([]);
    // No goal line without a rating, but where they want to grow still counts.
    expect(firstRead({ areas: {}, grow: ['money'] }, 'Save money')).toEqual(['You want to grow first: Money.', 'Your coach sees all of this, not just one goal. You can change it any time on the You tab.']);
  });

  it('finds the lowest and highest parts, ties in the usual order', () => {
    expect(lowest({ money: 1, work: 2, sleep: 2, mind: 1, fun: 3 })).toEqual(['mind', 'money']);
    expect(lowest({ money: 1, work: 2, sleep: 2, mind: 1 }, 3)).toEqual(['mind', 'money', 'sleep']);
    expect(lowest({ sleep: 3, fun: 4 })).toEqual([]);
    expect(lowest(undefined)).toEqual([]);
    expect(highest({ fun: 5, people: 5, body: 4 })).toBe('people');
    expect(highest({ meaning: 4, sleep: 3 })).toBe('meaning');
    expect(highest({ sleep: 3, work: 1 })).toBeNull();
  });

  it('shows what changed since the check-in before, or that nothing did', () => {
    const before = { at: '2026-09-15', areas: { sleep: 2, money: 3, work: 4, fun: 3 } };
    expect(changesSince({ areas: { money: 2, sleep: 3, work: 4, people: 5 } }, before)).toBe('Since 15 Sep: Sleep 2 → 3, Money 3 → 2.');
    expect(changesSince({ areas: { sleep: 2, work: 4 } }, before)).toBe('Same as on 15 Sep.');
    expect(changesSince({ areas: { sleep: 2 } }, null)).toBe('');
    expect(changesSince(null, before)).toBe('');
  });

  it('writes short dates the same in every browser', () => {
    expect(shortDate('2026-10-17')).toBe('17 Oct');
    expect(shortDate('2026-09-05')).toBe('5 Sep');
    expect(shortDate('nope')).toBe('');
  });
});

describe('the parts of life and their small steps', () => {
  it('has every word for every part, without long dashes', () => {
    for (const id of AREA_IDS) {
      const a = AREAS[id];
      for (const k of ['label', 'hint', 'focus', 'low', 'high', 'said'] as const) expect(a[k], `${id}.${k}`).toMatch(/^[^—–]+$/);
      expect(G.isCategory(GROW_CATEGORY[id]), id).toBe(true);
    }
  });

  it('makes a small step for each part that the goals accept as it is', () => {
    for (const id of AREA_IDS) {
      const step = AREA_STEPS[id];
      expect(G.isCategory(step.category), id).toBe(true);
      const q = G.cleanQuest(step.quest, '2026-10-17');
      expect(q, id).not.toBeNull();
      expect(q).toMatchObject(step.quest);
    }
    expect(AREA_STEPS.work.quest.schedule).toEqual({ kind: 'days', days: [0, 1, 2, 3, 4] });
    expect(G.scheduleText(AREA_STEPS.work.quest.schedule)).toBe('weekdays');
  });
});

describe('the daily check-in', () => {
  it('counts sleep, energy, mood or a few words', () => {
    expect([{ s: 2 }, { m: 1 }, { e: 5 }, { t: 'ok' }].map(hasCheckin)).toEqual([true, true, true, true]);
    expect([{ t: '  ' }, { e: null, s: null, m: null }, {}, null, undefined].map(hasCheckin)).toEqual([false, false, false, false, false]);
  });

  it('averages the last 4 weeks to one decimal, counting each field only where it was given', () => {
    const logs = {
      '2026-10-17': { s: 2, e: 3, m: 3 },
      '2026-10-16': { e: 4, m: 2 },
      '2026-10-15': { t: 'Only words' },
      '2026-09-20': { e: 3 }, // the first day of the 4 weeks
      '2026-09-19': { e: 1, s: 1 }, // the day before: left out
      '2026-10-18': { m: 5 }, // after today: left out
    };
    expect(checkinAverages(logs, '2026-10-17')).toEqual({ n: 3, s: 2, e: 3.3, m: 2.5 });
    expect(checkinAverages(logs, '2026-10-17', 2)).toEqual({ n: 2, s: 2, e: 3.5, m: 2.5 });
    expect(checkinAverages({}, '2026-10-17')).toEqual({ n: 0, s: null, e: null, m: null });
  });
});

describe("the coach's section on their life", () => {
  const profile = {
    name: 'Sam',
    life: { at: '2026-10-17', areas: { sleep: 2, body: 3, mind: 3, people: 5, work: 2, money: 3, fun: 2, meaning: 3 }, grow: ['sleep', 'meaning'], values: ['Family', 'Health', 'Faith'], hope: 'Feel fit, finish my degree\nand see my family more.' },
    lifeBefore: { at: '2026-09-15', areas: { sleep: 1, money: 3 } },
  };
  const logs = {
    '2026-10-17': { s: 2, e: 3, m: 3, at: 1 },
    '2026-10-16': { s: 4, e: 4, at: 1 },
    '2026-10-15': { t: 'Only words', at: 1 },
    '2026-10-13': { e: 1, at: 1 },
    '2026-10-10': { m: 5, at: 1 }, // more than 7 days ago: in the average only
  };
  const HEAD = '## Their life right now (their own answers in Arise; 1 = hard, 5 = great)';
  const RATED = 'Life check-in on 2026-10-17: Sleep 2, Body and health 3, Mood and mind 3, People you love 5, Work or study 2, Money 3, Fun and rest 2, Purpose 3.';

  it('has their ratings, the ones before, where they want to grow, what matters, their words and their check-ins', () => {
    expect(lifeLines(profile, logs, '2026-10-17')).toEqual([
      HEAD,
      RATED,
      'The one before, on 2026-09-15: Sleep 1, Money 3.',
      'They want to grow first: Sleep, Purpose.',
      'What matters most to them: Family, Health, Faith.',
      'A great next year, in their words: "Feel fit, finish my degree and see my family more."',
      'Daily check-ins, last 7 days (newest first): 2026-10-17 sleep 2, energy 3, mood 3; 2026-10-16 sleep 4, energy 4; 2026-10-13 energy 1.',
      'Last 4 weeks on average (4 check-ins): sleep 3.0, energy 2.7, mood 4.0.',
    ]);
  });

  it('keeps it short for small models: the ratings, where to grow, what matters and 3 days of check-ins', () => {
    expect(lifeLines(profile, logs, '2026-10-17', { compact: true })).toEqual([
      HEAD,
      RATED,
      'They want to grow first: Sleep, Purpose.',
      'What matters most to them: Family, Health, Faith.',
      'Daily check-ins, last 3 days (newest first): 2026-10-17 sleep 2, energy 3, mood 3; 2026-10-16 sleep 4, energy 4.',
    ]);
  });

  it('says when there is no life check-in yet, and still gives the daily ones', () => {
    const none = 'No life check-in yet. If it helps, ask about one part of their life you know nothing about.';
    expect(lifeLines({ name: 'Sam' }, {}, '2026-10-17')).toEqual([HEAD, none]);
    expect(lifeLines(null, { '2026-10-17': { m: 4, at: 1 } }, '2026-10-17')).toEqual([HEAD, none, 'Daily check-ins, last 7 days (newest first): 2026-10-17 mood 4.', 'Last 4 weeks on average (1 check-in): mood 4.0.']);
    // A broken one from storage counts as none.
    expect(lifeLines({ life: { at: 'today', areas: { sleep: 2 } } }, {}, '2026-10-17')).toEqual([HEAD, none]);
  });

  it("is never mistaken for what the life log knows (that's a different section, with its own tiers)", () => {
    const all = [lifeLines(profile, logs, '2026-10-17'), lifeLines(profile, logs, '2026-10-17', { compact: true }), lifeLines(null, {}, '2026-10-17')].flat().join('\n');
    expect(all).not.toContain('What Arise knows');
  });
});
