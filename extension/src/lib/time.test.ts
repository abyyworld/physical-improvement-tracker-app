// Time on each site, added up per site per hour of the clock.

import { describe, expect, it } from 'vitest';
import { HOUR, MAX_STEP, MINUTE, addSpan, dropFrom, hourEnd, hourStart, step, takeHours } from './time';

// Times on the local clock, whatever the time zone the tests run in.
const at = (h: number, m = 0, s = 0) => new Date(2026, 9, 17, h, m, s).getTime();

describe('time on site', () => {
  it('adds time to the hour it was in', () => {
    const r = addSpan({}, 'youtube.com', at(14, 10), at(14, 25));
    expect(r).toEqual({ [at(14)]: { 'youtube.com': 900 } });
    const r2 = addSpan(r, 'youtube.com', at(14, 30), at(14, 31));
    expect(r2[at(14)]['youtube.com']).toBe(960);
    expect(r[at(14)]['youtube.com']).toBe(900); // the old roll-up isn't changed
  });

  it('splits time that crosses into the next hour', () => {
    const r = addSpan({}, 'nytimes.com', at(9, 50), at(10, 20));
    expect(r).toEqual({ [at(9)]: { 'nytimes.com': 600 }, [at(10)]: { 'nytimes.com': 1200 } });
  });

  it('keeps sites apart, and ignores empty or backwards spans', () => {
    let r = addSpan({}, 'a.com', at(8, 0), at(8, 5));
    r = addSpan(r, 'b.com', at(8, 5), at(8, 6));
    r = addSpan(r, 'c.com', at(8, 6), at(8, 6));
    r = addSpan(r, 'd.com', at(8, 7), at(8, 6));
    r = addSpan(r, '', at(8, 7), at(8, 8));
    expect(r).toEqual({ [at(8)]: { 'a.com': 300, 'b.com': 60 } });
  });

  it('counts the site in front until the next look, but never across a long gap (the computer slept)', () => {
    let s = step({}, null, 'youtube.com', at(20, 0));
    expect(s.focus).toEqual({ site: 'youtube.com', since: at(20, 0) });
    s = step(s.rollup, s.focus, 'youtube.com', at(20, 1));
    s = step(s.rollup, s.focus, 'reddit.com', at(20, 2));
    expect(s.rollup[at(20)]).toEqual({ 'youtube.com': 120 });
    // Two hours without a look: only MAX_STEP of it counts.
    s = step(s.rollup, s.focus, null, at(22, 2));
    expect(s.rollup[at(20)]['reddit.com']).toBe(MAX_STEP / 1000);
    expect(s.focus).toBeNull();
    // Nothing in front: nothing counts.
    s = step(s.rollup, null, null, at(23));
    expect(Object.keys(s.rollup)).toEqual([String(at(20))]);
  });

  it('hands over the hours that are over, and keeps the one still going', () => {
    let r = addSpan({}, 'a.com', at(13, 0), at(13, 40));
    r = addSpan(r, 'b.com', at(13, 0), at(13, 0, 20)); // 20 seconds: too little to be worth a line
    r = addSpan(r, 'a.com', at(14, 0), at(14, 10));
    const { done, open } = takeHours(r, at(14, 30));
    expect(done).toEqual([{ hour: at(13), end: at(14), site: 'a.com', seconds: 2400 }]);
    expect(open).toEqual({ [at(14)]: { 'a.com': 600 } });
  });

  it('hands over everything when the browser closes, the hour so far ending now', () => {
    const r = addSpan({}, 'a.com', at(14, 0), at(14, 10));
    const { done, open } = takeHours(r, at(14, 12), { all: true });
    expect(done).toEqual([{ hour: at(14), end: at(14, 12), site: 'a.com', seconds: 600 }]);
    expect(open).toEqual({});
  });

  it('drops whole hours for "forget the last hour"', () => {
    let r = addSpan({}, 'a.com', at(12, 0), at(12, 30));
    r = addSpan(r, 'a.com', at(13, 0), at(13, 30));
    r = addSpan(r, 'a.com', at(14, 0), at(14, 10));
    expect(Object.keys(dropFrom(r, at(13, 15)))).toEqual([String(at(12))]);
    expect(Object.keys(dropFrom(r, at(14, 0)))).toEqual([String(at(12)), String(at(13))]);
  });

  it('knows where hours start and end', () => {
    expect(hourStart(at(7, 59, 59))).toBe(at(7));
    expect(hourEnd(at(7))).toBe(at(8));
    expect(hourEnd(at(7)) - at(7)).toBe(HOUR);
    expect(MINUTE).toBe(60_000);
  });
});
