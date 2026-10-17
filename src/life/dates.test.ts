// The dates in a question, in local time: "yesterday", "last Tuesday", "in March"…

import { describe, expect, it } from 'vitest';
import { addDays, dayEnd, dayKey, mondayOf, parseWhen, withoutWhen } from './dates';

const NOW = new Date(2026, 9, 17, 10, 0); // Saturday 17 October 2026, 10:00
const T = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();
const range = (q: string) => {
  const w = parseWhen(q, NOW);
  return w ? [dayKey(w.from), new Date(w.from).getHours(), dayKey(w.to - 1), new Date(w.to).getHours()] : null;
};

describe('days', () => {
  it('steps through days and weeks in local time', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(mondayOf('2026-10-17')).toBe('2026-10-12');
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(dayEnd('2026-10-17')).toBe(T(2026, 10, 18));
  });
});

describe('the dates in a question', () => {
  it('knows today, yesterday and the parts of a day', () => {
    expect(parseWhen('What did I do yesterday?', NOW)).toMatchObject({ from: T(2026, 10, 16), to: T(2026, 10, 17), label: 'yesterday (Fri 16 Oct)', match: 'yesterday' });
    expect(parseWhen('what happened today', NOW)).toMatchObject({ from: T(2026, 10, 17), to: T(2026, 10, 18) });
    expect(parseWhen('What did I eat this morning?', NOW)).toMatchObject({ from: T(2026, 10, 17, 0), to: T(2026, 10, 17, 12), label: 'this morning' });
    expect(parseWhen('how did I sleep last night', NOW)).toMatchObject({ from: T(2026, 10, 16, 18), to: T(2026, 10, 17, 6), label: 'last night' });
    expect(parseWhen('yesterday evening', NOW)).toMatchObject({ from: T(2026, 10, 16, 17), to: T(2026, 10, 17, 0) });
    expect(range('the day before yesterday')).toEqual(['2026-10-15', 0, '2026-10-15', 0]);
  });

  it('knows weekdays: "last Tuesday" is before today, "on Saturday" can be today', () => {
    expect(range('What did I do last Tuesday?')).toEqual(['2026-10-13', 0, '2026-10-13', 0]);
    expect(range('on Tuesday')).toEqual(['2026-10-13', 0, '2026-10-13', 0]);
    expect(range('last Saturday')).toEqual(['2026-10-10', 0, '2026-10-10', 0]);
    expect(range('on saturday')).toEqual(['2026-10-17', 0, '2026-10-17', 0]);
    expect(parseWhen('last Tuesday', NOW)?.label).toBe('last Tuesday (Tue 13 Oct)');
  });

  it('knows "N days/weeks/months ago"', () => {
    expect(range('3 days ago')).toEqual(['2026-10-14', 0, '2026-10-14', 0]);
    expect(range('what was I doing two weeks ago')).toEqual(['2026-09-28', 0, '2026-10-04', 0]);
    expect(parseWhen('two weeks ago', NOW)?.label).toMatch(/^two weeks ago, the week of 28 Sept?$/);
    expect(range('a month ago')).toEqual(['2026-09-01', 0, '2026-09-30', 0]);
    expect(range('a few days ago')).toEqual(['2026-10-13', 0, '2026-10-15', 0]);
    expect(range('a year ago')).toEqual(['2025-10-14', 0, '2025-10-20', 0]);
  });

  it('knows weeks, weekends, months and years', () => {
    expect(range('last week')).toEqual(['2026-10-05', 0, '2026-10-11', 0]);
    expect(range('this week')).toEqual(['2026-10-12', 0, '2026-10-17', 0]); // up to the end of today
    expect(range('last weekend')).toEqual(['2026-10-10', 0, '2026-10-11', 0]);
    expect(range('last month')).toEqual(['2026-09-01', 0, '2026-09-30', 0]);
    expect(parseWhen('last month', NOW)?.label).toBe('September 2026');
    expect(range('this year')).toEqual(['2026-01-01', 0, '2026-10-17', 0]);
    expect(range('last year')).toEqual(['2025-01-01', 0, '2025-12-31', 0]);
  });

  it('knows rolling spans', () => {
    expect(range('over the past two weeks')).toEqual(['2026-10-03', 0, '2026-10-17', 0]);
    expect(range('in the last 3 days')).toEqual(['2026-10-14', 0, '2026-10-17', 0]);
    expect(range('the past week')).toEqual(['2026-10-10', 0, '2026-10-17', 0]);
    expect(range('what have I been listening to lately')).toEqual(['2026-10-03', 0, '2026-10-17', 0]);
  });

  it('knows months, and puts a month that has not come yet in the year before', () => {
    expect(range('What did I do in March?')).toEqual(['2026-03-01', 0, '2026-03-31', 0]);
    expect(range('in November')).toEqual(['2025-11-01', 0, '2025-11-30', 0]);
    expect(range('in may')).toEqual(['2026-05-01', 0, '2026-05-31', 0]);
    expect(range('march 2024')).toEqual(['2024-03-01', 0, '2024-03-31', 0]);
    expect(range('this october')).toEqual(['2026-10-01', 0, '2026-10-17', 0]);
  });

  it('knows dates written out', () => {
    expect(range('on 3 October')).toEqual(['2026-10-03', 0, '2026-10-03', 0]);
    expect(range('October 3rd')).toEqual(['2026-10-03', 0, '2026-10-03', 0]);
    expect(range('the 3rd of oct')).toEqual(['2026-10-03', 0, '2026-10-03', 0]);
    expect(range('25 December')).toEqual(['2025-12-25', 0, '2025-12-25', 0]);
    expect(range('2026-10-01')).toEqual(['2026-10-01', 0, '2026-10-01', 0]);
    expect(range('5 jan 2025')).toEqual(['2025-01-05', 0, '2025-01-05', 0]);
  });

  it('knows "since"', () => {
    expect(range('since Monday')).toEqual(['2026-10-12', 0, '2026-10-17', 0]);
    expect(parseWhen('since March', NOW)).toMatchObject({ from: T(2026, 3, 1), to: T(2026, 10, 18), label: 'since March 2026' });
  });

  it('finds no date where there is none', () => {
    expect(parseWhen('What is my favourite song?', NOW)).toBeNull();
    expect(parseWhen('may I ask what I searched for', NOW)).toBeNull();
    expect(parseWhen('', NOW)).toBeNull();
  });

  it('reads a month that is also a first name as a name, unless something says it is the month', () => {
    expect(parseWhen('When did I last see Jan?', NOW)).toBeNull();
    expect(parseWhen('What did June say?', NOW)).toBeNull();
    expect(parseWhen('Did April call me back?', NOW)).toBeNull();
    expect(parseWhen('Dinner with August', NOW)).toBeNull();
    expect(range('What did I do in June?')).toEqual(['2026-06-01', 0, '2026-06-30', 0]);
    expect(range('last april')).toEqual(['2026-04-01', 0, '2026-04-30', 0]);
    expect(range('august 2025')).toEqual(['2025-08-01', 0, '2025-08-31', 0]);
    expect(range('since june')).toEqual(['2026-06-01', 0, '2026-10-17', 0]);
    expect(range('the 5th of jan')).toEqual(['2026-01-05', 0, '2026-01-05', 0]);
  });

  it('takes the date out of the question, whatever the punctuation in it', () => {
    const rest = (q: string) => withoutWhen(q, parseWhen(q, NOW)).replace(/\s+/g, ' ').trim();
    expect(rest('What did I do on Oct. 3?')).toBe('What did I do on ?');
    expect(rest('Where was I on October 3rd, 2025?')).toBe('Where was I on ?');
    expect(rest('How did I feel this morning?')).toBe('How did I feel ?');
    expect(rest('Anything from 2026-10-01 with Sam?')).toBe('Anything from with Sam?');
    expect(rest('Did I see Octavia in October?')).toBe('Did I see Octavia ?');
    expect(rest('What is my favourite song?')).toBe('What is my favourite song?');
  });
});
