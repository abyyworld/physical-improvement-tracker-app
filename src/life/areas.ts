// How each part of the Player's life is going, worked out from their days (src/life/signals.ts)
// with nothing for them to rate: the last 7 days compared with their own last 28, so 3 means
// "like usual for you", with a few plain limits where the number itself matters (under 6 hours
// of sleep a night is never better than 2). Each area says why, with the numbers and where they
// came from, or that there isn't enough to go on yet. When the Player rated an area themselves
// (the life check-in, now optional), their word goes next to it, never in its place.
//
// Also the words for what Arise saw: the chips for today, the week next to the usual, and the
// coach's section, each part only for an AI that may read it.
//
// Pure: no store, no log, no network.

import { AREA_IDS, AREAS, GROW_CATEGORY, SCALE, type AreaId } from '../lib/life-check';
import type { Category as GoalCategory } from '../lib/goals';
import { addDays, parseDay } from './dates';
import { duration } from './diary';
import type { LifeTier } from './types';
import type { DaySignals, SignalField, SourceWord } from './signals';

export const SOURCE_ORDER: readonly SourceWord[] = ['phone', 'Mac', 'browser', 'bank statements', 'imports', 'Arise'];

export type Trend = 'up' | 'down' | 'same';

export interface LifeArea {
  id: AreaId;
  label: string; // "Sleep", "Body and health"...
  score: number | null; // 1 to 5, 3 like usual; null: not enough to go on
  reason: string; // "About 6 h 40 min a night, 35 min less than usual (phone)."
  trend: Trend | null; // better or worse than usual, or like it
  tier: LifeTier; // the highest tier of what it was made from
  sources: SourceWord[];
  help?: string; // when there isn't enough to go on: what would help
  said?: { score: number; word: string }; // their own rating from the life check-in, when they gave one
}

export const NOT_ENOUGH = 'Not enough to go on yet.';
const HELP: Record<AreaId, string> = {
  sleep: 'Connect your phone (Health) or your Mac, and Arise works out your sleep.',
  body: 'Connect your phone (Health) for your steps and workouts.',
  mind: 'Connect your phone, Mac or browser.',
  people: "Connect your phone's calls and messages, or your Mac.",
  work: 'Connect your Mac or your browser.',
  money: 'Connect your bank statements in Connect.',
  fun: 'Connect your Mac, browser or phone.',
  meaning: 'Set a goal with quests, and Arise sees how it goes.',
};

// ---------- words

const list = (xs: readonly string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');
const ordered = (xs: Iterable<SourceWord>) => {
  const set = new Set(xs);
  return SOURCE_ORDER.filter((w) => set.has(w));
};
// "phone and Mac", for a reason's brackets.
const brackets = (xs: readonly SourceWord[]) => (xs.length ? ` (${list(ordered(xs))})` : '');

// "your phone, Mac and browser", "your phone and Arise", "Arise": for "from …".
export function sourcesText(xs: Iterable<SourceWord>): string {
  const w = ordered(xs);
  const mine = w.filter((x) => x !== 'Arise' && x !== 'imports');
  const parts = mine.map((x, i) => (i === 0 ? `your ${x}` : x));
  if (w.includes('imports')) parts.push('what you imported');
  if (w.includes('Arise')) parts.push('Arise');
  return list(parts);
}

const round = (n: number, step: number) => Math.round(n / step) * step;
// "6 h 40 min", to the nearest 10 minutes (5 under an hour).
const dur = (min: number) => duration(min < 60 ? Math.max(5, round(min, 5)) : round(min, 10));
const num = (n: number) => n.toLocaleString('en-GB');
const one = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
const clock = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
// ", 35 min less than usual" / ", like usual".
const vsUsual = (diff: number, small: number, say: (d: number) => string, more = 'more', less = 'less') =>
  Math.abs(diff) < small ? ', like usual' : `, ${say(Math.abs(diff))} ${diff > 0 ? more : less} than usual`;

// ---------- numbers

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
// How spread out the bedtimes are: the average distance from the middle one.
const spread = (xs: readonly number[]) => {
  const m = median(xs);
  return mean(xs.map((x) => Math.abs(x - m)));
};

interface Point {
  day: string;
  v: number;
  s: DaySignals;
}
interface Series {
  recent: Point[];
  base: Point[];
}

const RECENT = 7;
const BASE = 28;
const weekday = (k: string) => {
  const d = parseDay(k).getDay();
  return d >= 1 && d <= 5;
};
const weekend = (k: string) => !weekday(k);

// The last 7 days and the last 28 (the Player's usual), with a value. Last night's sleep is in
// already, so sleep counts up to today; the rest is still adding up today, so it stops yesterday.
const anyDay = (_k: string): boolean => true;
function series(signals: readonly DaySignals[], today: string, value: (s: DaySignals) => number | null | undefined, { upTo = false, days = anyDay }: { upTo?: boolean; days?: (k: string) => boolean } = {}): Series {
  const last = upTo ? today : addDays(today, -1);
  const recentFrom = addDays(last, -(RECENT - 1));
  const baseFrom = addDays(last, -(BASE - 1));
  const recent: Point[] = [];
  const base: Point[] = [];
  for (const s of signals) {
    if (s.day > last || s.day < baseFrom || !days(s.day)) continue;
    const v = value(s);
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    base.push({ day: s.day, v, s });
    if (s.day >= recentFrom) recent.push({ day: s.day, v, s });
  }
  return { recent, base };
}
const enough = (x: Series, recent = 4, base = 10) => x.recent.length >= recent && x.base.length >= base;
const vals = (ps: readonly Point[]) => ps.map((p) => p.v);

// How far the last week is from the usual, in the usual's own ups and downs (at least `minSd`):
// above 0 is better (`better`: which way is better).
function effect(x: Series, minSd: number, better: 1 | -1 = 1): number {
  const b = vals(x.base);
  return (better * (mean(vals(x.recent)) - mean(b))) / Math.max(sd(b), minSd);
}

interface Part {
  d: number;
  w: number;
  fields: SignalField[];
  x: Series; // what it was worked out from: the last week, and the usual next to it
}

const scoreOf = (d: number) => (d >= 1 ? 5 : d >= 0.35 ? 4 : d > -0.35 ? 3 : d > -1 ? 2 : 1);
const trendOf = (d: number): Trend => (d >= 0.35 ? 'up' : d <= -0.35 ? 'down' : 'same');

function make(id: AreaId, parts: readonly Part[], reason: string, ceiling = 5): Omit<LifeArea, 'said'> {
  const used = parts.filter((p) => p.w > 0 && Number.isFinite(p.d));
  const w = used.reduce((n, p) => n + p.w, 0);
  const d = used.reduce((n, p) => n + p.d * p.w, 0) / w;
  const tiers: LifeTier[] = [];
  const from: SourceWord[] = [];
  for (const p of used) {
    for (const f of p.fields) {
      // The score and "than usual" rest on the usual too, so its tiers count (the last week is in it).
      for (const pt of p.x.base) {
        const t = pt.s.tier[f];
        if (t) tiers.push(t);
      }
      for (const pt of p.x.recent) from.push(...(pt.s.from[f] || []));
    }
  }
  const sources = ordered(from);
  return {
    id,
    label: AREAS[id].label,
    score: Math.min(scoreOf(d), ceiling),
    reason: `${cap(reason)}${brackets(sources)}.`,
    // Better or worse than usual on the whole; when that comes out even, on what the reason starts
    // with (its main measure), so "1 h less than usual" is never called "like usual".
    trend: trendOf(d) === 'same' ? trendOf(used[0].d) : trendOf(d),
    tier: tiers.reduce<LifeTier>((a, b) => (b > a ? b : a), 1),
    sources,
  };
}

const unknown = (id: AreaId): Omit<LifeArea, 'said'> => ({ id, label: AREAS[id].label, score: null, reason: NOT_ENOUGH, trend: null, tier: 1, sources: [], help: HELP[id] });

// ---------- the areas

type Areas = Record<AreaId, (signals: readonly DaySignals[], today: string, grow: readonly AreaId[]) => Omit<LifeArea, 'said'>>;

const share = (by: DaySignals['questsBy'], cats: readonly GoalCategory[] | null, s: DaySignals) => {
  if (!cats) return s.due ? (s.done || 0) / s.due : null;
  let due = 0;
  let done = 0;
  for (const c of cats) {
    due += by?.[c]?.due || 0;
    done += by?.[c]?.done || 0;
  }
  return due ? done / due : null;
};
const finished = (ps: readonly Point[]) => ps.filter((p) => p.v >= 1).length;

const AREA_FNS: Areas = {
  sleep(signals, today) {
    const x = series(signals, today, (s) => s.sleepMin, { upTo: true });
    if (!enough(x)) return unknown('sleep');
    const parts: Part[] = [{ d: effect(x, 45), w: 0.7, fields: ['sleepMin'], x: x }];
    const bed = series(signals, today, (s) => s.bedtime, { upTo: true });
    let moved = false;
    if (enough(bed)) {
      const now = spread(vals(bed.recent));
      const usual = spread(vals(bed.base));
      parts.push({ d: (usual - now) / Math.max(usual, 30), w: 0.3, fields: ['bedtime'], x: bed });
      moved = now >= 60 && now > usual + 15;
    }
    const avg = mean(vals(x.recent));
    const about = x.recent.some((p) => p.s.sleepFrom === 'inferred') ? 'about ' : '';
    const reason = `${about}${dur(avg)} a night${vsUsual(avg - mean(vals(x.base)), 10, dur)}${moved ? '; bedtimes moved around' : ''}`;
    return make('sleep', parts, reason, avg < 360 ? 2 : 5);
  },

  body(signals, today) {
    const steps = series(signals, today, (s) => s.steps);
    const active = series(signals, today, (s) => s.active);
    if (!enough(steps) && !enough(active)) return unknown('body');
    const parts: Part[] = [];
    const bits: string[] = [];
    let ceiling = 5;
    if (enough(steps)) {
      const usual = mean(vals(steps.base));
      const avg = mean(vals(steps.recent));
      parts.push({ d: effect(steps, Math.max(800, 0.15 * usual)), w: 0.5, fields: ['steps'], x: steps });
      bits.push(`${num(round(avg, 100))} steps a day${vsUsual(avg - usual, 300, (d) => num(round(d, 100)), 'more', 'fewer')}`);
      if (avg < 3000) ceiling = 2;
    }
    if (enough(active)) {
      parts.push({ d: effect(active, 10), w: 0.3, fields: ['active'], x: active });
      const trained = series(signals, today, (s) => (typeof s.trained === 'boolean' ? (s.trained ? 1 : 0) : null));
      if (enough(trained)) parts.push({ d: (mean(vals(trained.recent)) - mean(vals(trained.base))) / 0.25, w: 0.2, fields: ['trained'], x: trained });
      const n = active.recent.filter((p) => p.v > 0 || p.s.trained).length;
      bits.push(n ? `${plural(n, 'day')} with a workout` : 'no workouts');
    }
    return make('body', parts, bits.join('; '), ceiling);
  },

  mind(signals, today) {
    const late = series(signals, today, (s) => s.lateMin, { upTo: true });
    const social = series(signals, today, (s) => s.socialMin);
    const screen = series(signals, today, (s) => s.screenMin);
    const mood = series(signals, today, (s) => s.mood, { upTo: true });
    const parts: Part[] = [];
    const bits: string[] = [];
    let ceiling = 5;
    if (enough(late)) {
      parts.push({ d: effect(late, 15, -1), w: 0.35, fields: ['lateMin'], x: late });
      const n = late.recent.filter((p) => p.v > 30).length;
      bits.push(n ? `up past midnight on ${n} of ${plural(late.recent.length, 'night')}` : 'no late nights');
      if (n >= 4) ceiling = 2;
    }
    if (enough(social) && vals(social.base).some((v) => v > 0)) {
      const avg = mean(vals(social.recent));
      parts.push({ d: effect(social, 15, -1), w: 0.3, fields: ['socialMin'], x: social });
      bits.push(`${avg >= 5 ? dur(avg) : 'almost no time'} a day on social feeds${vsUsual(avg - mean(vals(social.base)), 10, dur)}`);
    } else if (enough(screen)) {
      const avg = mean(vals(screen.recent));
      bits.push(`${dur(avg)} a day on screens${vsUsual(avg - mean(vals(screen.base)), 15, dur)}`);
    }
    if (enough(screen)) parts.push({ d: effect(screen, 45, -1), w: 0.15, fields: ['screenMin'], x: screen });
    if (enough(mood)) {
      parts.push({ d: effect(mood, 0.5), w: 0.4, fields: ['mood'], x: mood });
      bits.push(`mood ${mean(vals(mood.recent)).toFixed(1)} of 5`);
    }
    if (!parts.length) return unknown('mind');
    return make('mind', parts, bits.join('; '), ceiling);
  },

  people(signals, today) {
    const x = series(signals, today, (s) => s.people);
    if (!enough(x)) return unknown('people');
    const inTouch = (ps: readonly Point[]) => ps.filter((p) => p.v > 0).length / ps.length;
    const parts: Part[] = [
      { d: effect(x, 1), w: 0.6, fields: ['people'], x: x },
      { d: (inTouch(x.recent) - inTouch(x.base)) / 0.2, w: 0.4, fields: ['people'], x: x },
    ];
    const avg = mean(vals(x.recent));
    const days = x.recent.filter((p) => p.v > 0).length;
    const reason = days
      ? `in touch with ${one(avg)} ${avg >= 0.95 && avg < 1.05 ? 'person' : 'people'} a day, on ${days} of ${plural(x.recent.length, 'day')}${vsUsual(avg - mean(vals(x.base)), 0.5, one, 'more', 'fewer')}`
      : `no calls or messages with anyone in ${plural(x.recent.length, 'day')}`;
    return make('people', parts, reason, days <= 1 ? 2 : 5);
  },

  work(signals, today) {
    const focus = series(signals, today, (s) => s.focusMin, { days: weekday });
    const meetings = series(signals, today, (s) => s.meetingsMin, { days: weekday });
    const quests = series(signals, today, (s) => share(s.questsBy, ['career', 'learning'], s));
    const parts: Part[] = [];
    const bits: string[] = [];
    if (enough(focus, 3, 8)) {
      const avg = mean(vals(focus.recent));
      parts.push({ d: effect(focus, 30), w: 0.6, fields: ['focusMin'], x: focus });
      bits.push(`${avg >= 5 ? dur(avg) : 'hardly any time'} focused a weekday${vsUsual(avg - mean(vals(focus.base)), 15, dur)}`);
      if (enough(meetings, 3, 8)) {
        parts.push({ d: effect(meetings, 45, -1), w: 0.15, fields: ['meetingsMin'], x: meetings });
        const total = vals(meetings.recent).reduce((a, b) => a + b, 0);
        if (total >= 30) bits.push(`${dur(total)} in meetings this week`);
      }
    }
    if (enough(quests)) {
      parts.push({ d: effect(quests, 0.2), w: 0.25, fields: ['quests'], x: quests });
      bits.push(`work and study quests done on ${finished(quests.recent)} of ${plural(quests.recent.length, 'day')}`);
    }
    if (!parts.length) return unknown('work');
    return make('work', parts, bits.join('; '));
  },

  money(signals, today) {
    const spent = series(signals, today, (s) => s.spent);
    const quests = series(signals, today, (s) => share(s.questsBy, ['money'], s));
    const parts: Part[] = [];
    const bits: string[] = [];
    if (enough(spent)) {
      const usual = mean(vals(spent.base));
      const avg = mean(vals(spent.recent));
      parts.push({ d: effect(spent, Math.max(10, 0.3 * usual), -1), w: 0.7, fields: ['spent'], x: spent });
      const unit = spent.recent.find((p) => p.s.spentUnit)?.s.spentUnit || '';
      const pct = usual > 0 ? Math.round(((avg - usual) / usual) * 100) : 0;
      bits.push(`spent ${num(Math.round(avg))}${unit ? ` ${unit}` : ''} a day${Math.abs(pct) < 10 ? ', like usual' : `, ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'} than usual`}`);
    }
    if (enough(quests)) {
      parts.push({ d: effect(quests, 0.2), w: 0.3, fields: ['quests'], x: quests });
      bits.push(`money quests done on ${finished(quests.recent)} of ${plural(quests.recent.length, 'day')}`);
    }
    if (!parts.length) return unknown('money');
    return make('money', parts, bits.join('; '));
  },

  fun(signals, today) {
    const x = series(signals, today, (s) => s.funMin);
    if (!enough(x)) return unknown('fun');
    const some = (ps: readonly Point[]) => ps.filter((p) => p.v >= 15).length / ps.length;
    const parts: Part[] = [
      { d: effect(x, 20), w: 0.6, fields: ['funMin'], x: x },
      { d: (some(x.recent) - some(x.base)) / 0.2, w: 0.25, fields: ['funMin'], x: x },
    ];
    const avg = mean(vals(x.recent));
    const days = x.recent.filter((p) => p.v >= 15).length;
    const bits = [days ? `${dur(avg)} a day on videos, games and music, on ${days} of ${plural(x.recent.length, 'day')}` : `little time for videos, games or music in ${plural(x.recent.length, 'day')}`];
    const out = series(signals, today, (s) => s.places, { days: weekend });
    if (out.recent.length >= 1 && out.base.length >= 3) {
      parts.push({ d: effect(out, 1), w: 0.15, fields: ['places'], x: out });
      const n = mean(vals(out.recent));
      bits.push(n >= 0.5 ? `out to ${one(n)} ${n >= 0.95 && n < 1.05 ? 'place' : 'places'} a day at the weekend` : 'mostly home at the weekend');
    }
    return make('fun', parts, bits.join('; '));
  },

  meaning(signals, today, grow) {
    const all = series(signals, today, (s) => share(s.questsBy, null, s));
    if (!enough(all)) return unknown('meaning');
    const parts: Part[] = [{ d: effect(all, 0.2), w: 0.7, fields: ['quests'], x: all }];
    const cats = [...new Set(grow.map((a) => GROW_CATEGORY[a]))];
    if (cats.length) {
      const growing = series(signals, today, (s) => share(s.questsBy, cats, s));
      if (enough(growing)) parts.push({ d: effect(growing, 0.2), w: 0.3, fields: ['quests'], x: growing });
    }
    const n = finished(all.recent);
    const usual = (finished(all.base) / all.base.length) * all.recent.length;
    const reason = `finished your quests on ${n} of ${plural(all.recent.length, 'day')}${vsUsual(n - usual, 1, (d) => plural(Math.round(d), 'day'))}`;
    return make('meaning', parts, reason);
  },
};

// The eight parts of life, in the usual order, from the days up to `today`. `life`: the Player's
// own ratings (profile.life), shown next to them; `grow`, from it too, the parts they want to
// grow (their quests for those count a little more for Purpose).
export function lifeAreas(signals: readonly DaySignals[], today: string, { life }: { life?: { areas?: Partial<Record<AreaId, number>>; grow?: readonly AreaId[] } | null } = {}): LifeArea[] {
  const grow = (life?.grow || []).filter((a) => (AREA_IDS as readonly string[]).includes(a));
  return AREA_IDS.map((id) => {
    const a: LifeArea = AREA_FNS[id](signals, today, grow);
    const v = life?.areas?.[id];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) a.said = { score: v, word: SCALE[v - 1] };
    return a;
  });
}

// ---------- today, the week, the coach

export interface Seen {
  field: SignalField;
  text: string; // "Slept about 7 h 10 min", "6,400 steps", "Talked to 3 people"
  tier: LifeTier;
  from: SourceWord[];
}

// What Arise saw today and last night, as short chips, only what's known and not nothing.
export function seenToday(signals: readonly DaySignals[], today: string): Seen[] {
  const s = signals.find((x) => x.day === today);
  if (!s) return [];
  const out: Seen[] = [];
  const add = (field: SignalField, text: string) => out.push({ field, text, tier: s.tier[field] || 1, from: s.from[field] || [] });
  if (s.sleepMin) add('sleepMin', `Slept ${s.sleepFrom === 'inferred' ? 'about ' : ''}${dur(s.sleepMin)}`);
  if (s.steps) add('steps', `${num(s.steps)} steps`);
  if (s.active && s.active >= 5) add('active', `Worked out ${dur(s.active)}`);
  if (s.focusMin && s.focusMin >= 5) add('focusMin', `${dur(s.focusMin)} focused`);
  if (s.people) add('people', `Talked to ${plural(s.people, 'person', 'people')}`);
  if (s.funMin && s.funMin >= 5) add('funMin', `${dur(s.funMin)} on ${s.top?.fun?.length ? list(s.top.fun.slice(0, 2)) : 'videos, games and music'}`);
  return out;
}

export interface WeekCompare {
  avg: number; // a day (sleep: a night; lateNights: how many of `n`)
  n: number; // the days it rests on
  usual?: number; // the same over their last 28 days, when there are enough of them
  about?: boolean; // some of it worked out from the devices
  tier: LifeTier;
  from: SourceWord[];
}
export type WeekField = 'sleepMin' | 'steps' | 'active' | 'people' | 'focusMin' | 'funMin' | 'socialMin' | 'screenMin' | 'lateNights';

// The last 7 days next to the usual, for "Your week" on the Me tab.
export function weekCompare(signals: readonly DaySignals[], today: string): Partial<Record<WeekField, WeekCompare>> {
  const out: Partial<Record<WeekField, WeekCompare>> = {};
  const put = (k: WeekField, f: SignalField, x: Series, avg: (ps: readonly Point[]) => number) => {
    if (!x.recent.length) return;
    const usual = x.base.length >= 10;
    // With the usual next to it, its days' tiers count too.
    const tiers = (usual ? x.base : x.recent).map((p) => p.s.tier[f] || 1);
    const w: WeekCompare = { avg: avg(x.recent), n: x.recent.length, tier: tiers.reduce<LifeTier>((a, b) => (b > a ? b : a), 1), from: ordered(x.recent.flatMap((p) => p.s.from[f] || [])) };
    if (usual) w.usual = avg(x.base);
    if (f === 'sleepMin' && x.recent.some((p) => p.s.sleepFrom === 'inferred')) w.about = true;
    out[k] = w;
  };
  const avgOf = (ps: readonly Point[]) => mean(vals(ps));
  put('sleepMin', 'sleepMin', series(signals, today, (s) => s.sleepMin, { upTo: true }), avgOf);
  put('steps', 'steps', series(signals, today, (s) => s.steps), avgOf);
  put('active', 'active', series(signals, today, (s) => s.active), avgOf);
  put('people', 'people', series(signals, today, (s) => s.people), avgOf);
  put('focusMin', 'focusMin', series(signals, today, (s) => s.focusMin), avgOf);
  put('funMin', 'funMin', series(signals, today, (s) => s.funMin), avgOf);
  put('socialMin', 'socialMin', series(signals, today, (s) => s.socialMin), avgOf);
  put('screenMin', 'screenMin', series(signals, today, (s) => s.screenMin), avgOf);
  // Late nights: how many of the nights; the usual, scaled to as many nights.
  const late = series(signals, today, (s) => s.lateMin, { upTo: true });
  put('lateNights', 'lateMin', late, (ps) => (ps === late.recent ? ps.filter((p) => p.v > 30).length : (ps.filter((p) => p.v > 30).length / ps.length) * late.recent.length));
  return out;
}

const HEAD = '## What Arise saw (worked out on the device from the life log; nothing typed by them)';
const DAYS_NOTE = 'One line a day, oldest first. Sleep is the night before; "about" means worked out from when their phone or computer was in use.';
const AREAS_NOTE = 'How their life is going, worked out from their days and compared with their own usual (1 hard, 3 like usual, 5 great):';
const LEFT_OUT = "Some of what Arise saw uses parts of the life log this AI may not read, so it's left out.";
const TREND_WORDS: Record<Trend, string> = { up: 'better than usual', down: 'worse than usual', same: 'like usual' };

// One day in a line, each part only when this AI may read it. `left`: set when something was left out.
function dayLine(s: DaySignals, c: number, today: string, compact: boolean, left: { out: boolean; tier: LifeTier }): string {
  const parts: string[] = [];
  const ok = (f: SignalField) => {
    const t = s.tier[f];
    if (!t) return false;
    if (t > c) {
      left.out = true;
      return false;
    }
    if (t > left.tier) left.tier = t;
    return true;
  };
  const names = (k: 'work' | 'fun' | 'social') => (!compact && s.top?.[k]?.length ? ` (${s.top[k]!.join(', ')})` : '');
  if (s.sleepMin != null && ok('sleepMin')) {
    const times = s.bedtime != null && s.wake != null && ok('bedtime') && ok('wake') ? ` (${clock(s.bedtime)} to ${clock(s.wake)})` : '';
    parts.push(`slept ${s.sleepFrom === 'inferred' ? 'about ' : ''}${dur(s.sleepMin)}${times}`);
  }
  if (s.steps && ok('steps')) parts.push(`${num(s.steps)} steps`);
  if (s.active && s.active >= 5 && ok('active')) parts.push(`${dur(s.active)} of workouts`);
  else if (s.trained && ok('trained')) parts.push('worked out');
  if (s.places && ok('places')) parts.push(`went to ${plural(s.places, 'place')}`);
  if (s.people != null && ok('people')) {
    const how = [s.calls ? plural(s.calls, 'call') : '', s.messages ? plural(s.messages, 'message') : ''].filter(Boolean);
    parts.push(s.people ? `in touch with ${plural(s.people, 'person', 'people')}${how.length ? ` (${how.join(', ')})` : ''}` : 'in touch with no one');
  }
  if (s.focusMin && s.focusMin >= 5 && ok('focusMin')) parts.push(`${dur(s.focusMin)} focused${names('work')}`);
  if (s.funMin && s.funMin >= 5 && ok('funMin')) parts.push(`${dur(s.funMin)} of videos, games or music${names('fun')}`);
  if (s.socialMin && s.socialMin >= 5 && ok('socialMin')) parts.push(`${dur(s.socialMin)} on social feeds${names('social')}`);
  if (s.screenMin && s.screenMin >= 5 && ok('screenMin')) parts.push(`${dur(s.screenMin)} on screens`);
  if (s.lateMin && s.lateMin >= 5 && ok('lateMin')) parts.push(`${dur(s.lateMin)} on a screen after midnight`);
  if (s.meetingsMin && s.meetingsMin >= 5 && ok('meetingsMin')) parts.push(`${dur(s.meetingsMin)} of meetings`);
  if (s.due) {
    if (ok('quests')) parts.push(`quests ${s.done || 0} of ${s.due} done`);
  }
  const when = parseDay(s.day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return parts.length ? `- ${s.day === today ? `Today so far (${when})` : when}: ${parts.join('; ')}.` : '';
}

// Anything Arise saw from a device or an import, not only its own data?
const passive = (s: DaySignals) => Object.values(s.from).some((ws) => ws?.some((w) => w !== 'Arise'));

// The coach's section: the last 7 days (3 for a small model), the eight areas and why, each part
// only when its tier is within `c` (src/life/policy.ts), and a line when some was left out.
// Nothing at all before any device or import has told Arise anything.
export function signalsText(signals: readonly DaySignals[], areas: readonly LifeArea[], c: number, { compact = false, today = signals.at(-1)?.day || '' } = {}): { text: string; tier: LifeTier } {
  const week = signals.filter((s) => s.day <= today && s.day > addDays(today, compact ? -3 : -7));
  if (!week.some(passive) && !areas.some((a) => a.score != null && a.sources.some((w) => w !== 'Arise'))) return { text: '', tier: 1 };
  const left = { out: false, tier: 1 as LifeTier };
  const days = week.map((s) => dayLine(s, c, today, compact, left)).filter(Boolean);
  const shown: string[] = [];
  for (const a of areas) {
    if (a.score == null) {
      if (!compact) shown.push(`- ${a.label}: not enough to go on.`);
      continue;
    }
    if (a.tier > c) {
      left.out = true;
      continue;
    }
    if (a.tier > left.tier) left.tier = a.tier;
    shown.push(`- ${a.label}: ${a.score} of 5, ${TREND_WORDS[a.trend || 'same']}. ${a.reason}`);
  }
  const known = shown.some((l) => !l.endsWith('not enough to go on.'));
  if (!days.length && !known) return { text: left.out ? [HEAD, LEFT_OUT].join('\n') : '', tier: 1 };
  const lines = [HEAD];
  if (days.length) lines.push(DAYS_NOTE, ...days);
  if (known) lines.push(AREAS_NOTE, ...shown);
  if (left.out) lines.push(LEFT_OUT);
  return { text: lines.join('\n'), tier: left.tier };
}
