// "What Arise noticed": what goes with a person's good days, worked out on the device with no AI.
//
// Their own days over the last 6 weeks (today left out, it isn't over) are split in two by one
// thing (slept 7 hours or more, worked out, was in touch with someone...) and compared on one
// outcome: their energy, their mood, or finishing the day's quests. Simple comparisons, not proof:
// each needs at least 4 days on each side and a clear difference, says how many days it rests on,
// and only the stronger of two that measure the same thing (sleep as logged, sleep as they felt
// it) is kept. Nothing about money.
//
// Each pattern carries the highest tier of what it was made from (src/life/types.ts), so the coach
// only gets the ones its AI may read (src/life/insight.ts).
//
// Pure: the rows come from src/life/rows.ts (the life log and Arise's own data, one per day).

import type { LifeTier } from '../life/types';
import { addDays } from '../life/dates';
import { duration } from '../life/diary';

export const WINDOW_DAYS = 42;
const MIN_DAYS = 4; // on each side
const TOP = 5;

type Field = 'mood' | 'sleepMin' | 'steps' | 'trained' | 'people' | 'screenMin' | 'calMin';

// One day. A missing field (or null) means unknown, so that day sits out comparisons that need it.
export interface DayRow {
  day: string; // 2026-10-17
  e?: number | null; // energy from 1 to 5, from their check-in
  s?: number | null; // last night's sleep as they rated it, 1 to 5
  mood?: number | null; // 1 to 5: their check-in, else a mood they added, else Apple's State of Mind
  sleepMin?: number | null; // the night's sleep that ended that morning, in minutes
  steps?: number | null;
  trained?: boolean; // a workout in Arise, or in another app
  people?: boolean | null; // a call or a message with someone (null: no such source at all)
  screenMin?: number | null; // time in apps (only on days with app use)
  calMin?: number | null; // time in calendar events (null: no calendar)
  due?: number; // quests due that day (every day, or on set weekdays)
  done?: number; // of those, how many were ticked
  tier?: Partial<Record<Field, LifeTier>>; // how private each field's source is
}

// Without a tier given, what each field's sources usually are (src/life/tiers.ts): sleep, calls and
// messages are sensitive; steps, app use and the calendar are everyday activity.
const TIER: Record<Field, LifeTier> = { mood: 1, sleepMin: 3, steps: 2, trained: 1, people: 3, screenMin: 2, calMin: 2 };
const tierOf = (r: DayRow, f: Field): LifeTier => r.tier?.[f] || TIER[f];

export type Outcome = 'energy' | 'mood' | 'finished';
export type Factor = 'sleep7' | 'sleepFelt' | 'steps' | 'trained' | 'people' | 'screen' | 'busy' | 'questsDone';

export interface Pattern {
  outcome: Outcome;
  factor: Factor;
  text: string; // the sentence the Player (and the coach) reads
  yes: number; // the outcome's average on the days with the factor (finished: a share, 0 to 1)
  no: number; // and on the days without
  nYes: number;
  nNo: number;
  score: number;
  tier: LifeTier;
}

const rating = (v: unknown) => (typeof v === 'number' && v >= 1 && v <= 5 ? v : null);
const known = (xs: readonly (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
function median(xs: readonly number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface OutcomeDef {
  id: Outcome;
  scale: number; // the range of the outcome: 4 for a 1-5 rating, 1 for a share
  min: number; // the smallest difference worth naming
  value: (r: DayRow) => number | null;
  tier: (r: DayRow) => LifeTier;
}
const OUTCOMES: OutcomeDef[] = [
  { id: 'energy', scale: 4, min: 0.5, value: (r) => rating(r.e), tier: () => 1 },
  { id: 'mood', scale: 4, min: 0.5, value: (r) => rating(r.mood), tier: (r) => tierOf(r, 'mood') },
  { id: 'finished', scale: 1, min: 0.25, value: (r) => (r.due && r.due > 0 ? ((r.done || 0) >= r.due ? 1 : 0) : null), tier: () => 1 },
];

interface FactorDef {
  id: Factor;
  family: string; // only the stronger pattern per outcome and family is kept
  side: (r: DayRow) => boolean | null; // yes, no, or unknown
  tier: (r: DayRow) => LifeTier;
  yes: string;
  no: string;
}

// The factors, with thresholds from the window's own days: the steps and screen time around the
// middle of what this person does, not a number from a book.
function factors(win: readonly DayRow[]): FactorDef[] {
  const out: FactorDef[] = [
    { id: 'sleep7', family: 'sleep', side: (r) => (typeof r.sleepMin === 'number' ? r.sleepMin >= 420 : null), tier: (r) => tierOf(r, 'sleepMin'), yes: 'after 7 hours of sleep or more', no: 'after less sleep' },
    {
      id: 'sleepFelt',
      family: 'sleep',
      side: (r) => {
        const s = rating(r.s);
        return s == null ? null : s >= 4 ? true : s <= 2 ? false : null;
      },
      tier: () => 1,
      yes: 'after nights you rate your sleep good or great',
      no: 'after nights you rate it poor or awful',
    },
  ];
  const steps = roundTo(median(known(win.map((r) => r.steps)).filter((n) => n > 0)), 500);
  if (steps > 0) out.push({ id: 'steps', family: 'steps', side: (r) => (typeof r.steps === 'number' ? r.steps >= steps : null), tier: (r) => tierOf(r, 'steps'), yes: `on days you walk ${steps.toLocaleString('en-GB')} steps or more`, no: 'on days you walk less' });
  if (win.some((r) => r.trained)) out.push({ id: 'trained', family: 'trained', side: (r) => !!r.trained, tier: (r) => tierOf(r, 'trained'), yes: 'on days you work out', no: "on days you don't" });
  out.push({ id: 'people', family: 'people', side: (r) => (typeof r.people === 'boolean' ? r.people : null), tier: (r) => tierOf(r, 'people'), yes: "on days you're in touch with someone (calls or messages)", no: "on days you're not" });
  const screen = roundTo(median(known(win.map((r) => r.screenMin)).filter((n) => n > 0)), 30);
  if (screen > 0) out.push({ id: 'screen', family: 'screen', side: (r) => (typeof r.screenMin === 'number' ? r.screenMin < screen : null), tier: (r) => tierOf(r, 'screenMin'), yes: `on days with under ${duration(screen)} on screens`, no: 'on days with more' });
  const cal = median(known(win.map((r) => r.calMin)));
  if (cal >= 60) {
    const busy = roundTo(cal, 30);
    out.push({ id: 'busy', family: 'busy', side: (r) => (typeof r.calMin === 'number' ? r.calMin >= busy : null), tier: (r) => tierOf(r, 'calMin'), yes: `on days with ${duration(busy)} or more in your calendar`, no: 'on lighter days' });
  }
  out.push({ id: 'questsDone', family: 'quests', side: (r) => (r.due && r.due > 0 ? (r.done || 0) >= r.due : null), tier: () => 1, yes: 'on days you finish your quests', no: "on days you don't" });
  return out;
}

const pct = (x: number) => Math.round(x * 100);

function sentence(o: OutcomeDef, f: FactorDef, a: number, b: number, n: number) {
  if (o.id === 'finished') {
    // "on 80% of days you work out", not "of days on days you work out".
    const yes = f.yes.replace(/^on days /, '');
    return `You finish your quests on ${pct(a)}% of days ${yes}, and ${pct(b)}% ${f.no}.`;
  }
  return `Your ${o.id} is ${a > b ? 'higher' : 'lower'} ${f.yes}: ${a.toFixed(1)} vs ${b.toFixed(1)} (${n} days).`;
}

// The patterns in the 42 days before `today`, strongest first (at most 5).
export function findPatterns(rows: readonly DayRow[], today: string): Pattern[] {
  const from = addDays(today, -WINDOW_DAYS);
  const win = rows.filter((r) => r.day >= from && r.day < today);
  const fs = factors(win);
  const best = new Map<string, Pattern>();
  for (const o of OUTCOMES) {
    for (const f of fs) {
      if (o.id === 'finished' && f.id === 'questsDone') continue; // the same thing twice
      const yes: number[] = [];
      const no: number[] = [];
      let tier: LifeTier = 1;
      for (const r of win) {
        const v = o.value(r);
        const side = v == null ? null : f.side(r);
        if (v == null || side == null) continue;
        (side ? yes : no).push(v);
        tier = Math.max(tier, o.tier(r), f.tier(r)) as LifeTier;
      }
      if (yes.length < MIN_DAYS || no.length < MIN_DAYS) continue;
      const a = mean(yes);
      const b = mean(no);
      const diff = Math.abs(a - b);
      if (diff + 1e-9 < o.min) continue;
      const score = (diff / o.scale) * Math.sqrt(Math.min(yes.length, no.length));
      const key = `${o.id}:${f.family}`;
      if ((best.get(key)?.score ?? -1) >= score) continue;
      best.set(key, { outcome: o.id, factor: f.id, text: sentence(o, f, a, b, yes.length + no.length), yes: a, no: b, nYes: yes.length, nNo: no.length, score, tier });
    }
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, TOP);
}

// What the life log says about the last 4 weeks, in parts of a sentence ("you slept 7 h 10 min a
// night on average (21 nights)"), only those with data. For the screen only; never sent to an AI.
export function lifeAverages(rows: readonly DayRow[]): string[] {
  const out: string[] = [];
  const days = (n: number, one = 'day', many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const sleep = known(rows.map((r) => r.sleepMin)).filter((n) => n > 0);
  if (sleep.length) out.push(`you slept ${duration(roundTo(mean(sleep), 10))} a night on average (${days(sleep.length, 'night')})`);
  const steps = known(rows.map((r) => r.steps)).filter((n) => n > 0);
  if (steps.length) out.push(`walked ${roundTo(mean(steps), 100).toLocaleString('en-GB')} steps a day (${days(steps.length)})`);
  const people = rows.filter((r) => typeof r.people === 'boolean');
  if (people.length) out.push(`were in touch with someone on ${people.filter((r) => r.people).length} of ${days(people.length)}`);
  const screen = known(rows.map((r) => r.screenMin)).filter((n) => n > 0);
  if (screen.length) out.push(`spent ${duration(roundTo(mean(screen), 10))} a day on screens (${days(screen.length)})`);
  return out;
}
