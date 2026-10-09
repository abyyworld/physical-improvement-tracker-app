import { describe, expect, it } from 'vitest';
import { cleanState, type Settings } from './validate';

const DEFAULTS: Settings = { restBig: 120, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00', aiDaily: true, template: 'ab', perWeek: 5, notify: false, evening: true, eveningAt: '20:30', aiProvider: '', aiModel: '', aiBase: '', aiEngine: '', bar: 'home', dayOff: true };
const XSS = '"><img src=x onerror=alert(1)>';

const goodSession = (over = {}) => ({
  id: 'abc123',
  workout: 'a',
  date: '2026-10-01',
  started: 1000,
  finished: 2000,
  easy: false,
  items: [{ ex: 'band_row', setup: 'green band', sets: [{ r: 12, done: true }] }],
  ...over,
});

const clean = (raw: unknown) => cleanState(raw, DEFAULTS);

describe('backup and cloud data', () => {
  it('keeps a normal session as it is', () => {
    const s = clean({ sessions: [goodSession()] });
    expect(s.sessions).toEqual([goodSession()]);
  });

  it('drops sessions whose id could carry HTML into an attribute (the backup XSS from the audit)', () => {
    const s = clean({ sessions: [goodSession({ id: XSS }), goodSession({ id: 'ok1' })] });
    expect(s.sessions.map((x) => x.id)).toEqual(['ok1']);
  });

  it('turns rep values into plain numbers', () => {
    const s = clean({ sessions: [goodSession({ items: [{ ex: 'band_row', setup: '', sets: [{ r: XSS, done: true }, { r: '12', done: true }, { r: -5, done: true }, { r: 1e9, done: true }] }] })] });
    expect(s.sessions[0].items[0].sets.map((x) => x.r)).toEqual([0, 12, 0, 999]);
  });

  it("drops sessions with exercises the app doesn't know, instead of breaking every screen", () => {
    expect(clean({ sessions: [goodSession({ items: [{ ex: 'nope', sets: [] }] })] }).sessions).toEqual([]);
    expect(clean({ sessions: [goodSession({ items: [{ ex: '__proto__', sets: [] }] })] }).sessions).toEqual([]);
  });

  it('survives null and junk sets (the malformed backup that blanked the app)', () => {
    const s = clean({ sessions: [goodSession({ items: [{ ex: 'band_row', sets: [null, 'x', 7, { r: 10, done: true }] }] })] });
    expect(s.sessions[0].items[0].sets).toEqual([{ r: 10, done: true }]);
  });

  it('only keeps energy 1-5 and string notes in the daily log', () => {
    const s = clean({ logs: { '2026-10-01': { e: XSS, t: 'ok', at: 5 }, '2026-10-02': { e: 3, t: 42 }, 'not-a-date': { e: 2 }, [XSS]: { e: 1 } } });
    expect(s.logs).toEqual({ '2026-10-01': { e: null, t: 'ok', at: 5 }, '2026-10-02': { e: 3, at: 0 } });
  });

  it('only keeps real dates in day lists, sorted and without repeats', () => {
    const s = clean({ football: ['2026-10-02', '2026-10-01', '2026-10-01', XSS, '2026-13-01', 7], rests: 'nope' });
    expect(s.football).toEqual(['2026-10-01', '2026-10-02']);
    expect(s.rests).toEqual([]);
  });

  it('keeps body numbers numeric and in range', () => {
    const s = clean({ body: { phase: 'cut', phaseSince: '2026-09-01', entries: [{ date: '2026-10-01', weight: XSS, waist: '80,5', shoulders: 500 }, { date: '2026-10-02', weight: 75 }] } });
    expect(s.body.entries).toEqual([
      { date: '2026-10-01', weight: null, waist: 80.5, shoulders: null },
      { date: '2026-10-02', weight: 75, waist: null, shoulders: null },
    ]);
    expect(clean({ body: { phase: '__proto__' } }).body.phase).toBeNull();
  });

  it('keeps only known profile fields, with numbers as numbers', () => {
    const p = clean({ profile: { goal: 'Get strong', pullups: XSS, pushups: '20', tone: ['Calm', 5], evil: XSS, onboarded: 'yes' } }).profile;
    expect(p).toEqual({ goal: 'Get strong', pushups: 20, tone: ['Calm'] });
  });

  it('only accepts known settings values (a bad plan type used to crash every screen)', () => {
    const s = clean({ settings: { template: '__proto__', bar: XSS, perWeek: 99, restBig: 'x', remindAt: '25:00', aiProvider: 'constructor', aiBase: 'javascript:alert(1)', aiModel: '<b>', name: 'x'.repeat(50) } }).settings;
    expect(s).toMatchObject({ template: 'ab', bar: 'home', perWeek: 7, restBig: 120, remindAt: '07:00', aiProvider: '', aiBase: '', aiModel: '' });
    expect(s.name).toHaveLength(24);
    expect(clean({ settings: { aiBase: 'https://api.example.com/v1' } }).settings.aiBase).toBe('https://api.example.com/v1');
    expect(clean({ settings: { aiBase: 'http://localhost:11434/v1' } }).settings.aiBase).toBe('http://localhost:11434/v1');
    expect(clean({ settings: { aiBase: 'http://example.com/v1' } }).settings.aiBase).toBe('');
  });

  it('turns usage counts into numbers (the custom AI service XSS from the audit)', () => {
    const u = clean({ ai: { usage: { input: XSS, output: 5, calls: '7' } } }).ai.usage;
    expect(u).toEqual({ input: 0, output: 5, cacheWrite: 0, cacheRead: 0, otherIn: 0, otherOut: 0, calls: 0 });
  });

  it('cleans a saved custom plan, and drops one that is unusable', () => {
    const plan = { mode: 'rotation', order: ['x'], perWeek: 4, workouts: { x: { name: 'X', tag: 't', legs: false, slots: [{ ex: 'band_row', sets: 3, min: 8, max: 12 }] } } };
    expect(clean({ customPlan: plan }).customPlan).toMatchObject({ mode: 'rotation', order: ['x'], perWeek: 4 });
    expect(clean({ customPlan: { workouts: { [XSS]: { slots: [{ ex: 'band_row' }] } }, mode: 'rotation' } }).customPlan?.order[0]).toMatch(/^[a-z0-9_]{1,24}$/);
    expect(clean({ customPlan: { workouts: { x: { slots: [{ ex: 'nope' }] } } } }).customPlan).toBeNull();
  });

  it('drops a broken workout in progress instead of refusing to open', () => {
    expect(clean({ active: { id: 'a1', workout: 'a', date: '2026-10-01', slots: [{ ex: 'band_row', sets: 3 }], items: [] } }).active).toBeNull();
    const ok = clean({ active: { id: 'a1', workout: 'a', date: '2026-10-01', slots: [{ ex: 'band_row', sets: 3, min: 8, max: 12 }], items: [{ ex: 'band_row', setup: '', sets: [{ r: '', done: false }] }], timer: { mode: 'rest', end: 5, total: 60 } } }).active;
    expect(ok?.items[0].sets).toEqual([{ r: 0, done: false }]);
    expect(ok?.timer).toEqual({ mode: 'rest', end: 5, total: 60 });
  });

  it('gives a complete, blank state for junk', () => {
    for (const junk of [null, 5, 'x', [], { sessions: 'no', logs: [], body: 7, ai: null }]) {
      const s = clean(junk);
      expect(s.sessions).toEqual([]);
      expect(s.settings).toEqual(DEFAULTS);
      expect(s.ai.chat).toEqual([]);
    }
  });

  it('caps chat history and long text', () => {
    const chat = Array.from({ length: 500 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(30000), at: i }));
    const s = clean({ ai: { chat } });
    expect(s.ai.chat).toHaveLength(200);
    expect(s.ai.chat[0].text).toHaveLength(20000);
  });
});
