// The journal Arise writes from the life log with no AI: hour by hour, busy stretches merged,
// grouped into the parts of the day, through time zones and daylight saving changes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LifeEvent } from './types';
import { buildJournal, duration, lineFor, parseText, shareText, siteOf, splitLine, toText } from './diary';

// London's clocks (set before the times below are worked out), whatever the machine uses.
const ZONE = process.env.TZ;
process.env.TZ = 'Europe/London';
beforeAll(() => {
  process.env.TZ = 'Europe/London';
});
afterAll(() => {
  process.env.TZ = ZONE;
});

// A time on the clock in London that day.
const T = (k: string, h: number, m = 0) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};
let n = 0;
const ev = (e: Partial<LifeEvent> & Pick<LifeEvent, 'source' | 'kind' | 'at' | 'title'>): LifeEvent => ({ id: `${e.source}:t${++n}`, tier: 2, ...e }) as LifeEvent;

const DAY = '2026-10-16'; // a Friday, in British Summer Time
const day: LifeEvent[] = [
  ev({ source: 'health', kind: 'sleep', at: T('2026-10-15', 23, 30), end: T(DAY, 6, 40), title: 'Slept 7 h 10 min', value: 430, unit: 'min' }),
  ev({ source: 'arise', kind: 'quest', at: T(DAY, 8), title: 'Done: Study Spanish', tier: 1 }),
  ev({ source: 'arise', kind: 'quest', at: T(DAY, 8, 30), title: 'Done: Read 10 pages', tier: 1 }),
  ev({ source: 'arise', kind: 'workout', at: T(DAY, 9), end: T(DAY, 10, 5), title: 'Workout: Push', detail: 'Push-up 20/18; Dip 10/10; Pike 8/8; Plank 60/60; Squat 15/15; Lunge 10/10; Calf raise 20/20', value: 65, unit: 'min', tier: 1 }),
  ev({ source: 'spotify', kind: 'listen', at: T(DAY, 10, 10), title: 'Listened to Daft Punk: One More Time' }),
  ev({ source: 'spotify', kind: 'listen', at: T(DAY, 10, 15), title: 'Listened to Justice: D.A.N.C.E.' }),
  ev({ source: 'spotify', kind: 'listen', at: T(DAY, 10, 40), end: T(DAY, 10, 44), title: 'Listened to Daft Punk: Digital Love' }),
  ev({ source: 'chrome', kind: 'visit', at: T(DAY, 11, 2), title: 'Show HN', url: 'https://news.ycombinator.com/item?id=1', tier: 3 }),
  ev({ source: 'chrome', kind: 'visit', at: T(DAY, 11, 10), title: 'A video', url: 'https://www.youtube.com/watch?v=x', tier: 3 }),
  ev({ source: 'chrome', kind: 'visit', at: T(DAY, 11, 15), title: 'r/running', url: 'https://www.reddit.com/r/running', tier: 3 }),
  ev({ source: 'chrome', kind: 'visit', at: T(DAY, 11, 40), title: 'News', url: 'https://www.bbc.co.uk/news', tier: 3 }),
  ev({ source: 'google', kind: 'search', at: T(DAY, 13, 20), title: 'Searched "flights to Rome"', tier: 3 }),
  ev({ source: 'other', kind: 'app', at: T(DAY, 14), title: 'Used Instagram for 25 min', value: 25, unit: 'min', meta: { app: 'Instagram' } }),
  ev({ source: 'other', kind: 'app', at: T(DAY, 15), title: 'Used Instagram for 10 min', value: 10, unit: 'min', meta: { app: 'Instagram' } }),
  ev({ source: 'other', kind: 'app', at: T(DAY, 15), title: 'Used WhatsApp for 8 min', value: 8, unit: 'min', meta: { app: 'WhatsApp' } }),
  ev({ source: 'health', kind: 'sleep', at: T(DAY, 15, 30), end: T(DAY, 16), title: 'Napped 30 min', value: 30, unit: 'min' }),
  ev({ source: 'android', kind: 'notification', at: T(DAY, 16), title: 'Slack: Sam', tier: 3 }),
  ev({ source: 'health', kind: 'steps', at: T(DAY, 12), title: '5,000 steps', value: 5000 }),
  ev({ source: 'health', kind: 'steps', at: T(DAY, 18), title: '4,200 steps', value: 4200 }),
  ev({ source: 'steam', kind: 'play', at: T(DAY, 21), title: 'Played Elden Ring', value: 120, unit: 'min' }),
  ev({ source: 'netflix', kind: 'watch', at: T(DAY, 22, 30), title: 'Watched Dark: S1E1' }),
  ev({ source: 'netflix', kind: 'watch', at: T(DAY, 22, 50), title: 'Watched Dark: S1E2' }),
  ev({ source: 'health', kind: 'sleep', at: T(DAY, 23, 55), end: T('2026-10-17', 7), title: 'Slept 7 h 5 min', value: 425, unit: 'min' }),
  { id: `arise:journal:${DAY}`, source: 'arise', kind: 'note', at: T(DAY, 21, 40), title: 'Journal: Good day.', detail: 'Good day. Tired after the gym.\n\nEnergy 4/5.', value: 4, unit: 'energy (1-5)', tier: 1 },
  // From the day before: only its sleep (above) belongs here.
  ev({ source: 'netflix', kind: 'watch', at: T('2026-10-15', 22), title: 'Watched Dark: S1E0' }),
];

describe('the journal from the log', () => {
  it('writes the day hour by hour, merging busy stretches, in the parts of the day', () => {
    const j = buildJournal(day, DAY, { now: T('2026-10-17', 9) });
    expect(j.parts.map((p) => p.part)).toEqual(['morning', 'afternoon', 'evening', 'night']);
    expect(Object.fromEntries(j.parts.map((p) => [p.part, p.lines]))).toEqual({
      morning: [
        '06:40 Woke up after 7 h 10 min of sleep',
        '08:00 Done: Study Spanish and Read 10 pages',
        '09:00 to 10:05 Push workout, 7 exercises',
        '10:10 to 10:44 Music: Daft Punk and Justice',
        '11:02 Browsed: Hacker News, YouTube, Reddit and 1 more',
      ],
      afternoon: ['13:20 Searched flights to Rome', '14:00 Apps: Instagram 35 min and WhatsApp 8 min', '15:30 to 16:00 Nap, 30 min'],
      evening: ['21:00 Played Elden Ring for 2 h'],
      night: ['22:30 Watched Dark, 2 episodes', '23:55 Went to sleep'],
    });
    expect(j.intro).toBe('I slept 7 h 10 min, did a workout, finished 2 quests, walked 9,200 steps and played Elden Ring for 2 h. My energy was 4 out of 5.');
    expect(j.own).toEqual({ text: 'Good day. Tired after the gym.', energy: 4 });
    expect(j.empty).toBe(false);
    // Nothing from the day before, and no notifications.
    expect(toText(j)).not.toMatch(/S1E0|Slack/);
  });

  it('says "you" when asked, and "so far" for today', () => {
    expect(buildJournal(day, DAY, { voice: 'you', now: T('2026-10-17', 9) }).intro).toMatch(/^You slept 7 h 10 min,.* Your energy was 4 out of 5\.$/);
    expect(buildJournal(day, DAY, { now: T(DAY, 23, 59) }).intro).toMatch(/^So far today, I slept 7 h 10 min/);
  });

  it("takes the Player's own words from their Daily log when given, over the log's copy", () => {
    expect(buildJournal(day, DAY, { own: { text: 'Fresh words.', energy: 5 } }).own).toEqual({ text: 'Fresh words.', energy: 5 });
  });

  it('is empty for a day with nothing in it', () => {
    const j = buildJournal([], DAY);
    expect(j).toMatchObject({ intro: '', parts: [], empty: true, count: 0, own: null });
    // Only the night before's sleep: just waking up.
    const woke = buildJournal([day[0]], DAY);
    expect(woke.parts).toEqual([{ part: 'morning', lines: ['06:40 Woke up after 7 h 10 min of sleep'] }]);
    expect(woke.intro).toBe('I slept 7 h 10 min.');
    // Only the Player's words: not empty.
    expect(buildJournal([], DAY, { own: { text: 'Rest day.' } })).toMatchObject({ empty: false, own: { text: 'Rest day.', energy: null } });
  });

  it('keeps the same thing once an hour, and names sites and searches plainly', () => {
    const notes = [ev({ source: 'maps', kind: 'place', at: T(DAY, 12, 5), title: 'At Café Nero' }), ev({ source: 'maps', kind: 'place', at: T(DAY, 12, 40), title: 'At Café Nero' })];
    expect(buildJournal(notes, DAY).parts[0].lines).toEqual(['12:05 At Café Nero']);
    const searches = ['a', 'b', 'c', 'd'].map((q, i) => ev({ source: 'google', kind: 'search', at: T(DAY, 19, i), title: `Searched "${q}"` }));
    expect(buildJournal(searches, DAY).parts[0].lines).toEqual(['19:00 Searched: a, b, c and 1 more']);
    expect(siteOf({ url: 'https://en.m.wikipedia.org/wiki/Rome', title: '' })).toBe('Wikipedia');
    expect(siteOf({ url: 'https://shop.example.co.uk/x', title: '' })).toBe('Example');
    expect(siteOf({ title: 'Visited The Verge' })).toBe('The Verge');
  });

  it('keeps a run of the same game together, and splits it after a long break', () => {
    const games = [
      ev({ source: 'steam', kind: 'play', at: T(DAY, 18), end: T(DAY, 19), title: 'Played Hades' }),
      ev({ source: 'steam', kind: 'play', at: T(DAY, 19, 10), end: T(DAY, 19, 40), title: 'Played Hades' }),
      ev({ source: 'steam', kind: 'play', at: T(DAY, 21), end: T(DAY, 21, 20), title: 'Played Hades' }),
    ];
    expect(buildJournal(games, DAY).parts[0].lines).toEqual(['18:00 Played Hades for 1 h 30 min', '21:00 Played Hades for 20 min']);
  });

  it('formats lengths of time', () => {
    expect([duration(0.2), duration(25), duration(60), duration(430), duration(1440)]).toEqual(['1 min', '25 min', '1 h', '7 h 10 min', '24 h']);
  });
});

describe('time zones and the clocks changing', () => {
  it('counts a night in which the clocks go back by its real length, and keeps both 01:30s', () => {
    // London, Sunday 25 October 2026: 02:00 summer time becomes 01:00, so 01:30 happens twice.
    const k = '2026-10-25';
    const list = [
      ev({ source: 'health', kind: 'sleep', at: Date.UTC(2026, 9, 24, 22), end: Date.UTC(2026, 9, 25, 7), title: 'Slept 9 h', value: 540, unit: 'min' }), // 23:00 BST to 07:00 GMT
      ev({ source: 'manual', kind: 'note', at: Date.UTC(2026, 9, 25, 0, 30), title: 'Still up (summer time)' }), // 01:30 BST
      ev({ source: 'manual', kind: 'note', at: Date.UTC(2026, 9, 25, 1, 30), title: 'Still up (winter time)' }), // 01:30 GMT
      ev({ source: 'manual', kind: 'note', at: Date.UTC(2026, 9, 25, 23, 30), title: 'Late note' }), // 23:30 GMT, still the 25th
    ];
    const j = buildJournal(list, k);
    expect(j.parts).toEqual([
      { part: 'early', lines: ['01:30 Still up (summer time)', '01:30 Still up (winter time)'] },
      { part: 'morning', lines: ['07:00 Woke up after 9 h of sleep'] },
      { part: 'night', lines: ['23:30 Late note'] },
    ]);
    expect(toText(j)).toContain('After midnight\n01:30 Still up');
  });

  it('counts a night in which the clocks go forward by its real length', () => {
    // London, Sunday 29 March 2026: 01:00 becomes 02:00. 23:00 to 07:00 on the clock is 7 hours.
    const j = buildJournal([ev({ source: 'health', kind: 'sleep', at: Date.UTC(2026, 2, 28, 23), end: Date.UTC(2026, 2, 29, 6), title: 'Slept 7 h', value: 420, unit: 'min' })], '2026-03-29');
    expect(j.parts).toEqual([{ part: 'morning', lines: ['07:00 Woke up after 7 h of sleep'] }]);
  });

  it("files each thing under the hour on this device's clock", () => {
    const at = Date.UTC(2026, 9, 16, 23, 30); // 00:30 on the 17th in London, 08:30 in Tokyo
    const list = [ev({ source: 'manual', kind: 'note', at, title: 'A note' })];
    expect(buildJournal(list, '2026-10-17').parts).toEqual([{ part: 'early', lines: ['00:30 A note'] }]);
    process.env.TZ = 'Asia/Tokyo';
    try {
      expect(buildJournal(list, '2026-10-17').parts).toEqual([{ part: 'morning', lines: ['08:30 A note'] }]);
      expect(buildJournal(list, '2026-10-16').empty).toBe(true);
    } finally {
      process.env.TZ = 'Europe/London';
    }
  });
});

describe('the journal as text', () => {
  it('writes and reads back the parts, so an edit keeps its shape', () => {
    const j = buildJournal(day, DAY);
    const text = toText(j);
    expect(text.split('\n').slice(0, 4)).toEqual([j.intro, '', 'Morning', '06:40 Woke up after 7 h 10 min of sleep']);
    expect(parseText(text)).toEqual({ intro: j.intro, parts: j.parts });
    // Headings in any case, with a colon, and paragraphs the Player typed.
    expect(parseText('A lovely day.\nTruly.\n\nmorning:\nI ran.\n\nNIGHT\nSlept early.\n\nMorning\nCoffee.')).toEqual({
      intro: 'A lovely day.\nTruly.',
      parts: [
        { part: 'night', lines: ['Slept early.'] },
        { part: 'morning', lines: ['I ran.', 'Coffee.'] },
      ],
    });
    expect(parseText('')).toEqual({ intro: '', parts: [] });
  });

  it('splits a line into its time and what happened, and gives one line for a notification', () => {
    expect(splitLine('09:00 to 10:05 Push workout, 7 exercises')).toEqual({ time: '09:00 to 10:05', text: 'Push workout, 7 exercises' });
    expect(splitLine('I went for a run.')).toEqual({ time: '', text: 'I went for a run.' });
    expect(lineFor({ intro: 'I slept well. Then I ran.', parts: [] })).toBe('I slept well.');
    expect(lineFor({ intro: '', parts: [{ part: 'morning', lines: ['07:00 Coffee'] }] })).toBe('07:00 Coffee');
    expect(lineFor({ intro: 'x'.repeat(300), parts: [] })).toHaveLength(140);
  });

  it('shares with a title and the Player’s own words', () => {
    const j = buildJournal(day, DAY);
    const text = shareText(j, { title: 'Friday 16 October', own: j.own });
    expect(text.startsWith('Friday 16 October\n\nI slept 7 h 10 min')).toBe(true);
    expect(text.endsWith('In my words (energy 4/5): Good day. Tired after the gym.')).toBe(true);
  });
});
