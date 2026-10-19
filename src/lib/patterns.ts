// "What Arise noticed": what goes with a person's good days, worked out on the device with no AI.
//
// Their own days over the last 6 weeks (today left out, it isn't over) are split in two by one
// thing (slept 7 hours or more, worked out, was in touch with someone, was up past midnight...) and
// compared on one outcome: how long they slept the night after, their focused time, how many people
// they were in touch with, and, when they gave them, their energy, their mood, or finishing the
// day's quests. None of it needs anyone to rate or write anything. Simple comparisons, not proof:
// each needs at least 4 days on each side and a clear difference, says how many days it rests on,
// and only the stronger of two that measure the same thing (sleep as logged, sleep as they felt
// it) is kept. Nothing about money.
//
// Each pattern carries the highest tier of what it was made from (src/life/types.ts), so the coach
// only gets the ones its AI may read (src/life/insight.ts).
//
// Pure: the rows come from src/life/rows.ts and src/life/signals.ts (the life log and Arise's own
// data, one per day).

import type { LifeTier } from '../life/types';
import { addDays } from '../life/dates';
import { duration } from '../life/diary';

export const WINDOW_DAYS = 42;
const MIN_DAYS = 4; // on each side
const TOP = 5;

type Field = 'mood' | 'sleepMin' | 'steps' | 'trained' | 'people' | 'screenMin' | 'calMin' | 'peopleN' | 'focusMin' | 'funMin' | 'socialMin' | 'lateMin';

// One day. A missing field (or null) means unknown, so that day sits out comparisons that need it.
export interface DayRow {
  day: string; // 2026-10-17
  e?: number | null; // energy from 1 to 5, from their check-in
  s?: number | null; // last night's sleep as they rated it, 1 to 5
  mood?: number | null; // 1 to 5: their check-in, else a mood they added, else Apple's State of Mind
  sleepMin?: number | null; // the night's sleep that ended that morning, in minutes
  sleepFrom?: 'health' | 'inferred'; // from Health, or worked out from when the devices were in use
  steps?: number | null;
  trained?: boolean; // a workout in Arise, or in another app
  people?: boolean | null; // a call or a message with someone (null: no such source at all)
  screenMin?: number | null; // time in apps (only on days with app use)
  calMin?: number | null; // time in calendar events (null: no calendar)
  peopleN?: number | null; // how many people they were in touch with (src/life/signals.ts)
  focusMin?: number | null; // time in work and study apps and sites
  funMin?: number | null; // videos, games and music
  socialMin?: number | null; // social feeds
  lateMin?: number | null; // time on a device between midnight and 5 am (the night before this day)
  due?: number; // quests due that day (every day, or on set weekdays)
  done?: number; // of those, how many were ticked
  tier?: Partial<Record<Field, LifeTier>>; // how private each field's source is
}

// Without a tier given, what each field's sources usually are (src/life/tiers.ts): sleep, calls and
// messages are sensitive; steps, app use and the calendar are everyday activity.
// The rest, made from app use and browsing, messages and the night's activity: sensitive, unless
// the row says otherwise.
const TIER: Record<Field, LifeTier> = { mood: 1, sleepMin: 3, steps: 2, trained: 1, people: 3, screenMin: 2, calMin: 2, peopleN: 3, focusMin: 3, funMin: 3, socialMin: 3, lateMin: 3 };
const tierOf = (r: DayRow, f: Field): LifeTier => r.tier?.[f] || TIER[f];

export type Outcome = 'energy' | 'mood' | 'finished' | 'sleepMin' | 'focusMin' | 'people';
export type Factor = 'sleep7' | 'sleepFelt' | 'steps' | 'trained' | 'people' | 'screen' | 'busy' | 'questsDone' | 'late' | 'socialHigh' | 'fun';

export interface Pattern {
  outcome: Outcome;
  factor: Factor;
  text: string; // the sentence the Player (and the coach) reads
  yes: number; // the outcome's average on the days with the factor (finished: a share, 0 to 1; sleep and focus: minutes)
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
  scale: number; // the range of the outcome: 4 for a 1-5 rating, 1 for a share; minutes or people for the rest
  min: number; // the smallest difference worth naming
  value: (r: DayRow) => number | null;
  tier: (r: DayRow) => LifeTier;
  night?: boolean; // about the night after the day (its value is on the next day's row)
  skip?: readonly string[]; // factor families that are the same thing, or part of it
}
const minutes = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const OUTCOMES: OutcomeDef[] = [
  { id: 'energy', scale: 4, min: 0.5, value: (r) => rating(r.e), tier: () => 1 },
  { id: 'mood', scale: 4, min: 0.5, value: (r) => rating(r.mood), tier: (r) => tierOf(r, 'mood') },
  { id: 'finished', scale: 1, min: 0.25, value: (r) => (r.due && r.due > 0 ? ((r.done || 0) >= r.due ? 1 : 0) : null), tier: () => 1, skip: ['quests'] },
  // Asked of no one: how long they slept that night, their focused time, the people they talked to.
  { id: 'sleepMin', scale: 160, min: 20, value: (r) => (typeof r.sleepMin === 'number' && r.sleepMin > 0 ? r.sleepMin : null), tier: (r) => tierOf(r, 'sleepMin'), night: true, skip: ['sleep'] },
  { id: 'focusMin', scale: 240, min: 30, value: (r) => minutes(r.focusMin), tier: (r) => tierOf(r, 'focusMin'), skip: ['screen'] },
  { id: 'people', scale: 8, min: 1, value: (r) => minutes(r.peopleN), tier: (r) => tierOf(r, 'peopleN'), skip: ['people'] },
];

interface FactorDef {
  id: Factor;
  family: string; // only the stronger pattern per outcome and family is kept
  side: (r: DayRow) => boolean | null; // yes, no, or unknown
  tier: (r: DayRow) => LifeTier;
  yes: string;
  no: string;
  night?: string; // about the night before the day: how to say it of that same night
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
  // From the devices alone: up past midnight, a lot of social feeds, an hour or more of fun.
  out.push({
    id: 'late',
    family: 'late',
    side: (r) => (typeof r.lateMin === 'number' ? r.lateMin > 30 : null),
    tier: (r) => tierOf(r, 'lateMin'),
    yes: 'after nights on your phone or computer past midnight',
    no: 'after other nights',
    night: "on nights you're on your phone or computer past midnight",
  });
  const social = Math.max(30, roundTo(median(known(win.map((r) => r.socialMin)).filter((n) => n > 0)), 15));
  out.push({ id: 'socialHigh', family: 'social', side: (r) => (typeof r.socialMin === 'number' ? r.socialMin >= social : null), tier: (r) => tierOf(r, 'socialMin'), yes: `on days with ${duration(social)} or more on social feeds`, no: 'on days with less' });
  out.push({ id: 'fun', family: 'fun', side: (r) => (typeof r.funMin === 'number' ? r.funMin > 60 : null), tier: (r) => tierOf(r, 'funMin'), yes: 'on days with over an hour of videos, games or music', no: 'on days with less' });
  return out;
}

const pct = (x: number) => Math.round(x * 100);

// "1 h 20 min", to the nearest 10 minutes (5 under half an hour).
const howLong = (min: number) => duration(min < 30 ? Math.max(5, roundTo(min, 5)) : roundTo(min, 10));

function sentence(o: OutcomeDef, f: FactorDef, a: number, b: number, n: number) {
  if (o.id === 'finished') {
    // "on 80% of days you work out", not "of days on days you work out".
    const yes = f.yes.replace(/^on days /, '');
    return `You finish your quests on ${pct(a)}% of days ${yes}, and ${pct(b)}% ${f.no}.`;
  }
  const more = a > b;
  if (o.id === 'sleepMin') {
    // The night after a day ("after days you work out"), or that same night ("on nights you're up").
    const when = f.night || f.yes.replace(/^on /, 'after ');
    return `You sleep ${howLong(Math.abs(a - b))} ${more ? 'more' : 'less'} ${when} (${n} days).`;
  }
  if (o.id === 'focusMin') return `You focus ${howLong(Math.abs(a - b))} ${more ? 'more' : 'less'} ${f.yes} (${n} days).`;
  if (o.id === 'people') return `You're in touch with ${more ? 'more' : 'fewer'} people ${f.yes}: ${a.toFixed(1)} vs ${b.toFixed(1)} a day (${n} days).`;
  return `Your ${o.id} is ${more ? 'higher' : 'lower'} ${f.yes}: ${a.toFixed(1)} vs ${b.toFixed(1)} (${n} days).`;
}

// The patterns in the 42 days before `today`, strongest first (at most 5). Sleep is the night
// after each day, so the night that ended this morning counts too.
export function findPatterns(rows: readonly DayRow[], today: string): Pattern[] {
  const from = addDays(today, -WINDOW_DAYS);
  const win = rows.filter((r) => r.day >= from && r.day < today);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const after = (r: DayRow) => byDay.get(addDays(r.day, 1)) ?? null;
  const fs = factors(win);
  const best = new Map<string, Pattern>();
  for (const o of OUTCOMES) {
    for (const f of fs) {
      if (o.skip?.includes(f.family)) continue; // the same thing twice, or part of it
      const yes: number[] = [];
      const no: number[] = [];
      let tier: LifeTier = 1;
      for (const r of win) {
        // The night after the day: its sleep is on the next day's row, and so is that night's
        // time up past midnight.
        const next = o.night ? after(r) : r;
        if (!next || next.day > today) continue;
        const v = o.value(next);
        const at = o.night && f.night ? next : r;
        const side = v == null ? null : f.side(at);
        if (v == null || side == null) continue;
        (side ? yes : no).push(v);
        tier = Math.max(tier, o.tier(next), f.tier(at)) as LifeTier;
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

// The last 7 days in numbers, for "Your week" on the Me tab: each part only when it has data, as
// an average and the days it rests on (people: the days in touch, of the days that could tell).
// Last night's sleep and today's check-in are in already, so those count the 7 days up to today;
// steps, people and screens are still adding up today, so those count the 7 days before it. For
// the screen only; never sent to an AI.
export interface WeekNumber {
  avg: number;
  n: number;
}
export interface WeekNumbers {
  sleepMin?: WeekNumber; // minutes a night, to the nearest 10
  sleepFelt?: WeekNumber; // how they said they slept, 1 to 5 (only without sleepMin)
  energy?: WeekNumber;
  mood?: WeekNumber;
  steps?: WeekNumber; // to the nearest 100
  people?: WeekNumber; // avg: the days in touch with someone, n: the days with calls or messages known
  screenMin?: WeekNumber; // minutes a day, to the nearest 10
}
export function weekNumbers(rows: readonly DayRow[], today: string): WeekNumbers {
  const upTo = rows.filter((r) => r.day > addDays(today, -7) && r.day <= today);
  const before = rows.filter((r) => r.day >= addDays(today, -7) && r.day < today);
  const out: WeekNumbers = {};
  const avg = (xs: number[], step = 0): WeekNumber | undefined => (xs.length ? { avg: step ? roundTo(mean(xs), step) : Math.round(mean(xs) * 10) / 10, n: xs.length } : undefined);
  const set = <K extends keyof WeekNumbers>(k: K, v: WeekNumber | undefined) => {
    if (v) out[k] = v;
  };
  set('sleepMin', avg(known(upTo.map((r) => r.sleepMin)).filter((n) => n > 0), 10));
  if (!out.sleepMin) set('sleepFelt', avg(known(upTo.map((r) => rating(r.s)))));
  set('energy', avg(known(upTo.map((r) => rating(r.e)))));
  set('mood', avg(known(upTo.map((r) => rating(r.mood)))));
  set('steps', avg(known(before.map((r) => r.steps)).filter((n) => n > 0), 100));
  const people = before.filter((r) => typeof r.people === 'boolean');
  if (people.length) out.people = { avg: people.filter((r) => r.people).length, n: people.length };
  set('screenMin', avg(known(before.map((r) => r.screenMin)).filter((n) => n > 0), 10));
  return out;
}
