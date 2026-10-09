// Reminder times: local times in any time zone turned into UTC, through daylight saving changes.

import { describe, expect, it } from 'vitest';
import { ALL_DAYS, addDays, localDate, nextDue, timeZone, toUTC, weekday, type Due, type Schedule } from './schedule';

const utc = (s: string) => Date.parse(`${s}Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

describe('local time to UTC', () => {
  it.each([
    ['Europe/London', '2026-07-01', '07:30', '2026-07-01T06:30'], // summer time, UTC+1
    ['Europe/London', '2026-12-01', '07:30', '2026-12-01T07:30'],
    ['America/New_York', '2026-07-01', '07:30', '2026-07-01T11:30'],
    ['America/New_York', '2026-12-01', '07:30', '2026-12-01T12:30'],
    ['Asia/Kolkata', '2026-10-09', '07:30', '2026-10-09T02:00'], // UTC+5:30, no daylight saving
    ['Asia/Tokyo', '2026-10-09', '00:15', '2026-10-08T15:15'], // the day before in UTC
    ['Pacific/Chatham', '2026-01-15', '07:30', '2026-01-14T17:45'], // UTC+13:45 in its summer
    ['America/Los_Angeles', '2026-10-09', '23:59', '2026-10-10T06:59'],
    ['UTC', '2026-10-09', '20:00', '2026-10-09T20:00'],
  ])('%s: %s %s is %s UTC', (tz, date, time, want) => {
    expect(iso(toUTC(date, time, tz))).toBe(want);
  });

  it('moves a time that clocks skip on by the jump', () => {
    // London goes from 01:00 to 02:00 on 29 March 2026: 01:30 becomes 02:30 summer time.
    expect(iso(toUTC('2026-03-29', '01:30', 'Europe/London'))).toBe('2026-03-29T01:30');
    // New York skips 02:00 to 03:00 on 8 March 2026: 02:30 becomes 03:30.
    expect(iso(toUTC('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30');
    // Lord Howe Island's clocks only jump half an hour (02:00 to 02:30 on 4 October 2026).
    expect(iso(toUTC('2026-10-04', '02:15', 'Australia/Lord_Howe'))).toBe('2026-10-03T15:45');
  });

  it('takes the first of a time that happens twice when clocks go back', () => {
    // London: 01:00 to 02:00 happens twice on 25 October 2026, first in summer time (UTC+1).
    expect(iso(toUTC('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30');
    // New York, 1 November 2026: the first 01:30 is still daylight time (UTC-4).
    expect(iso(toUTC('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30');
  });

  it('keeps the same clock time on either side of a change, in both hemispheres', () => {
    expect(iso(toUTC('2026-10-24', '07:30', 'Europe/London'))).toBe('2026-10-24T06:30');
    expect(iso(toUTC('2026-10-25', '07:30', 'Europe/London'))).toBe('2026-10-25T07:30');
    // Sydney starts summer time on 4 October 2026 (UTC+10 to UTC+11).
    expect(iso(toUTC('2026-10-03', '07:30', 'Australia/Sydney'))).toBe('2026-10-02T21:30');
    expect(iso(toUTC('2026-10-04', '07:30', 'Australia/Sydney'))).toBe('2026-10-03T20:30');
  });
});

describe('dates', () => {
  it('gives the local date at a moment', () => {
    const t = utc('2026-10-09T23:30');
    expect(localDate(t, 'Europe/London')).toBe('2026-10-10');
    expect(localDate(t, 'America/New_York')).toBe('2026-10-09');
    expect(localDate(t, 'Asia/Kolkata')).toBe('2026-10-10');
    expect(localDate(utc('2026-10-10T09:00'), 'Pacific/Honolulu')).toBe('2026-10-09');
  });

  it('counts days and weekdays', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(weekday('2026-10-09')).toBe(5); // a Friday
    expect(weekday('2026-10-11')).toBe(0); // Sunday
  });

  it('knows real time zones only', () => {
    expect(timeZone('Europe/London')).toBe('Europe/London');
    expect(timeZone('europe/london')).toBe('Europe/London');
    expect(timeZone('UTC')).toBe('UTC');
    for (const bad of ['Mars/Olympus_Mons', '', '../../etc/passwd', 'Europe/London; DROP TABLE', 42, null, 'x'.repeat(80)]) expect(timeZone(bad)).toBe('');
  });

  it('keeps one formatter per time zone, however its name is capitalised', () => {
    // Otherwise each new capitalisation someone sends keeps another one in memory for good.
    const Real = Intl.DateTimeFormat;
    let made = 0;
    Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof Real>) {
      made++;
      return new Real(...args);
    } as unknown as typeof Real;
    try {
      const name = 'Africa/Nairobi';
      for (let i = 0; i < 200; i++) {
        const spelled = [...name].map((c, j) => ((i >> j % 8) & 1 ? c.toUpperCase() : c.toLowerCase())).join('');
        expect(timeZone(spelled)).toBe(name);
      }
      expect(localDate(utc('2026-10-09T22:00'), 'africa/nairobi')).toBe('2026-10-10');
      expect(made).toBe(1);
    } finally {
      Intl.DateTimeFormat = Real;
    }
  });
});

describe('the next reminder', () => {
  const london: Schedule = { tz: 'Europe/London', morning: '07:30', evening: '20:00', days: ALL_DAYS };
  const show = (d: Due | null) => (d ? `${d.kind} ${d.date} ${iso(d.at)}` : null);

  // The reminders one after another from `from`, as the server sends them.
  function run(s: Schedule, from: string, n: number, done?: string) {
    const out: string[] = [];
    let now = utc(from);
    let sent: Due | null = null;
    for (let i = 0; i < n; i++) {
      const d = nextDue(s, now, { sent, done });
      if (!d) break;
      out.push(show(d)!);
      sent = d;
      now = d.at;
    }
    return out;
  }

  it('sends the morning, the evening check, then the next morning', () => {
    expect(run(london, '2026-10-09T05:00', 4)).toEqual([
      'morning 2026-10-09 2026-10-09T06:30',
      'evening 2026-10-09 2026-10-09T19:00',
      'morning 2026-10-10 2026-10-10T06:30',
      'evening 2026-10-10 2026-10-10T19:00',
    ]);
  });

  it('keeps 07:30 at 07:30 on the clock when summer time ends', () => {
    expect(run({ ...london, evening: null }, '2026-10-23T12:00', 4)).toEqual([
      'morning 2026-10-24 2026-10-24T06:30',
      'morning 2026-10-25 2026-10-25T07:30',
      'morning 2026-10-26 2026-10-26T07:30',
      'morning 2026-10-27 2026-10-27T07:30',
    ]);
  });

  it("keeps the next morning when clocks skip past midnight and a day's evening moves after it", () => {
    // Greenland skips 23:00 to 00:00 on Saturday 28 March 2026, so that evening's 23:30 becomes
    // 00:30 on Sunday, after Sunday's 00:15 morning. Sunday's morning comes, not Saturday's late
    // evening check (it would be after midnight anyway).
    expect(run({ tz: 'America/Nuuk', morning: '00:15', evening: '23:30', days: ALL_DAYS }, '2026-03-28T12:00', 3)).toEqual([
      'morning 2026-03-29 2026-03-29T01:15',
      'evening 2026-03-29 2026-03-30T00:30',
      'morning 2026-03-30 2026-03-30T01:15',
    ]);
  });

  it('starts from the right day in time zones far from UTC', () => {
    // 23:30 UTC on Friday is already 05:00 on Saturday in Kolkata.
    expect(show(nextDue({ tz: 'Asia/Kolkata', morning: '07:00', evening: null, days: ALL_DAYS }, utc('2026-10-09T23:30')))).toBe('morning 2026-10-10 2026-10-10T01:30');
    // And 23:30 UTC is still 13:30 on Friday in Honolulu: the evening check comes first.
    expect(show(nextDue({ tz: 'Pacific/Honolulu', morning: '07:00', evening: '19:00', days: ALL_DAYS }, utc('2026-10-09T23:30')))).toBe('evening 2026-10-09 2026-10-10T05:00');
  });

  it('only on the chosen weekdays', () => {
    const weekdays = { ...london, evening: null, days: 0b0111110 }; // Monday to Friday
    // Friday 9 October, then straight to Monday.
    expect(run(weekdays, '2026-10-09T05:00', 2)).toEqual(['morning 2026-10-09 2026-10-09T06:30', 'morning 2026-10-12 2026-10-12T06:30']);
    expect(nextDue({ ...london, days: 0 }, utc('2026-10-09T05:00'))).toBeNull();
  });

  it('skips what is left of a day marked done', () => {
    // Done before the morning reminder: nothing that day.
    expect(run(london, '2026-10-09T05:00', 1, '2026-10-09')).toEqual(['morning 2026-10-10 2026-10-10T06:30']);
    // Done after it: no evening check.
    const sent = { date: '2026-10-09', kind: 'morning' as const };
    expect(show(nextDue(london, utc('2026-10-09T12:00'), { sent, done: '2026-10-09' }))).toBe('morning 2026-10-10 2026-10-10T06:30');
    expect(show(nextDue(london, utc('2026-10-09T12:00'), { sent, done: '2026-10-08' }))).toBe('evening 2026-10-09 2026-10-09T19:00');
  });

  it("never sends a day's reminder twice when the times change", () => {
    // The 07:30 reminder went out; at 07:45 the morning time moves to 08:00.
    const sent = { date: '2026-10-09', kind: 'morning' as const };
    expect(show(nextDue({ ...london, morning: '08:00' }, utc('2026-10-09T06:45'), { sent }))).toBe('evening 2026-10-09 2026-10-09T19:00');
    // After the evening check, a later evening time waits for tomorrow.
    expect(show(nextDue({ ...london, evening: '21:00' }, utc('2026-10-09T19:05'), { sent: { date: '2026-10-09', kind: 'evening' } }))).toBe('morning 2026-10-10 2026-10-10T06:30');
    // Flying west after the evening check: the day isn't repeated in the new time zone.
    const ny = { ...london, tz: 'America/New_York' };
    expect(show(nextDue(ny, utc('2026-10-09T19:05'), { sent: { date: '2026-10-09', kind: 'evening' } }))).toBe('morning 2026-10-10 2026-10-10T11:30');
  });

  it('leaves out an evening check that is not after the morning', () => {
    expect(run({ ...london, morning: '20:00', evening: '07:30' }, '2026-10-09T05:00', 2)).toEqual(['morning 2026-10-09 2026-10-09T19:00', 'morning 2026-10-10 2026-10-10T19:00']);
  });
});
