// The whole person: how each part of their life is going, in their own words.
//
// The life check-in (the intro, then about once a month) rates eight parts of life from 1 (hard)
// to 5 (great), with up to two parts to grow first, what matters most to them and what would
// make the next year a great one. It's kept in profile.life, and the one before it in
// profile.lifeBefore, so a change can be shown. The daily check-in is sleep, energy and mood from
// 1 to 5 and a few words, in logs[day] (s, e, m and t).
//
// Pure: no store, no look. The screens, the coach's context (lifeLines) and the clean rules in
// validate.ts all read the words and rules from here.

import { isDate, str } from './clean';
import type { Category, Schedule } from './goals';

export const AREA_IDS = ['sleep', 'body', 'mind', 'people', 'work', 'money', 'fun', 'meaning'] as const;
export type AreaId = (typeof AREA_IDS)[number];
export const isArea = (v: unknown): v is AreaId => typeof v === 'string' && (AREA_IDS as readonly string[]).includes(v);
export const SCALE = ['Hard', 'Not great', 'Okay', 'Good', 'Great'] as const; // a life rating 1..5
export const CHECKIN = {
  s: { label: 'Sleep last night', words: ['Awful', 'Poor', 'Okay', 'Good', 'Great'] },
  e: { label: 'Energy', words: ['Drained', 'Low', 'Okay', 'Good', 'Unstoppable'] },
  m: { label: 'Mood', words: ['Low', 'Meh', 'Okay', 'Good', 'Great'] },
} as const;
export const VALUES = ['Family', 'Health', 'Faith', 'Friends', 'Love', 'Freedom', 'Growth', 'Calm', 'Creativity', 'Adventure', 'Security', 'Helping others', 'Doing great work', 'Fun'];
export interface Life {
  at: string;
  areas: Partial<Record<AreaId, number>>;
  grow: AreaId[];
  values: string[];
  hope: string;
}
export interface LifeBefore {
  at: string;
  areas: Partial<Record<AreaId, number>>;
}

// label: its name; hint: what it covers; focus: it, mid-sentence; low and high: what a rating of
// 1-2 or 4-5 says back; said: the no-AI coach's line on a day it's low.
export const AREAS: Record<AreaId, { label: string; hint: string; focus: string; low: string; high: string; said: string }> = {
  sleep: {
    label: 'Sleep',
    hint: 'How well you sleep',
    focus: 'sleep',
    low: 'Sleep is rough right now. Almost everything gets easier when sleep does.',
    high: 'You sleep well. Worth protecting.',
    said: "You said sleep is hard right now. Protect tonight's sleep.",
  },
  body: {
    label: 'Body and health',
    hint: 'Fitness, food, how your body feels',
    focus: 'your health',
    low: 'Your body and health need some care right now.',
    high: 'Your body feels good. Worth protecting.',
    said: 'You said your health needs care right now. Something small for your body counts.',
  },
  mind: {
    label: 'Mood and mind',
    hint: 'Stress, calm, focus',
    focus: 'how you feel',
    low: "You're carrying a lot right now. Go easy on yourself.",
    high: "You're in a good place in yourself.",
    said: "You said you're carrying a lot right now. Go easy on yourself today.",
  },
  people: {
    label: 'People you love',
    hint: 'Family, friends, partner',
    focus: 'the people you love',
    low: 'Time with the people you love feels thin right now.',
    high: 'You have people you love around you.',
    said: 'You said time with people you love feels thin. A message to one of them counts.',
  },
  work: {
    label: 'Work or study',
    hint: "How it's going",
    focus: 'work or study',
    low: 'Work or study is hard right now.',
    high: 'Work or study is going well.',
    said: 'You said work or study is hard right now. One focused block is enough.',
  },
  money: {
    label: 'Money',
    hint: 'How you feel about it',
    focus: 'money',
    low: 'Money is a worry right now.',
    high: 'Money feels steady.',
    said: 'You said money is a worry right now. One small money step is enough.',
  },
  fun: {
    label: 'Fun and rest',
    hint: 'Time off, things you enjoy',
    focus: 'rest and fun',
    low: "There's not much fun or rest in your days right now.",
    high: 'You make room for fun and rest.',
    said: "You said there's little fun or rest lately. Make a little room for something you enjoy.",
  },
  meaning: {
    label: 'Purpose',
    hint: 'Feeling your life is going somewhere',
    focus: 'what gives your life purpose',
    low: "Your life doesn't feel like it's going where you want right now. That's worth listening to.",
    high: "Your life feels like it's going somewhere.",
    said: "You said your life doesn't feel like it's going where you want. Ten quiet minutes on what matters to you counts.",
  },
};

// The kind of goal the intro picks first for the part they want to grow.
export const GROW_CATEGORY: Record<AreaId, Category> = { sleep: 'health', body: 'fitness', mind: 'mind', people: 'relationships', work: 'career', money: 'money', fun: 'habits', meaning: 'other' };

// One small step for each part of life, for someone with no goal yet (a goal with one quest).
export const AREA_STEPS: Record<AreaId, { goal: string; category: Category; quest: { title: string; schedule: Schedule; amount?: { target: number; unit: string } } }> = {
  sleep: { goal: 'Sleep better', category: 'health', quest: { title: 'Lights out on time', schedule: { kind: 'daily' } } },
  body: { goal: 'Feel good in my body', category: 'fitness', quest: { title: 'Walk', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' } } },
  mind: { goal: 'A calmer, clearer mind', category: 'mind', quest: { title: 'No phone for the first hour', schedule: { kind: 'daily' } } },
  people: { goal: 'Closer to my people', category: 'relationships', quest: { title: 'Reach out to someone', schedule: { kind: 'weekly', times: 3 } } },
  work: { goal: 'Make work or study move', category: 'career', quest: { title: 'Plan tomorrow', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] } } },
  money: { goal: 'Feel calmer about money', category: 'money', quest: { title: 'Check my budget', schedule: { kind: 'weekly', times: 1 } } },
  fun: { goal: "Time that's mine", category: 'habits', quest: { title: 'An hour for me', schedule: { kind: 'weekly', times: 3 } } },
  meaning: { goal: 'Live closer to what matters', category: 'other', quest: { title: 'Ten minutes on what matters to me', schedule: { kind: 'weekly', times: 3 } } },
};

// ---------- cleaning (profile.life and lifeBefore come from storage, sync and backups)

type Areas = Partial<Record<AreaId, number>>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rating = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5 ? (v as number) : 0);

// Known parts of life with a whole rating from 1 to 5, in the usual order.
export function cleanAreas(raw: unknown): Areas {
  const a = obj(raw);
  const out: Areas = {};
  for (const id of AREA_IDS) if (Object.hasOwn(a, id) && rating(a[id])) out[id] = a[id] as number;
  return out;
}

export function cleanLife(raw: unknown): Life | null {
  const l = obj(raw);
  if (!isDate(l.at)) return null;
  const areas = cleanAreas(l.areas);
  const grow = [...new Set(arr(l.grow).filter(isArea))].slice(0, 2);
  const values = [...new Set(arr(l.values).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().slice(0, 30)))].slice(0, 3);
  const hope = str(l.hope, 2000);
  if (!Object.keys(areas).length && !grow.length && !values.length && !hope.trim()) return null;
  return { at: l.at, areas, grow, values, hope };
}

export function cleanLifeBefore(raw: unknown): LifeBefore | null {
  const l = obj(raw);
  const areas = cleanAreas(l.areas);
  return isDate(l.at) && Object.keys(areas).length ? { at: l.at, areas } : null;
}

// ---------- the daily check-in

// A day's check-in as validate.ts keeps it (logs[day]).
export interface CheckinLog {
  s?: number | null;
  e?: number | null;
  m?: number | null;
  t?: string;
  ai?: string;
  at?: number;
}

// Anything in a day's check-in: sleep, energy, mood or a few words.
export const hasCheckin = (l: CheckinLog | null | undefined) => !!(l && (l.e || l.s || l.m || (l.t && l.t.trim())));

// ---------- reading the ratings

// The parts rated 1 or 2, lowest first (ties in the usual order).
export function lowest(areas: Areas | null | undefined, n = 2): AreaId[] {
  const a = areas || {};
  return AREA_IDS.filter((id) => (a[id] || 0) >= 1 && a[id]! <= 2)
    .sort((x, y) => a[x]! - a[y]! || AREA_IDS.indexOf(x) - AREA_IDS.indexOf(y))
    .slice(0, n);
}

// The part rated highest, if it's 4 or 5 (the first in the usual order on a tie).
export function highest(areas: Areas | null | undefined): AreaId | null {
  const a = areas || {};
  let best: AreaId | null = null;
  for (const id of AREA_IDS) if ((a[id] || 0) >= 4 && (!best || a[id]! > a[best]!)) best = id;
  return best;
}

// "17 Oct". Month names are fixed: browsers disagree on September ("Sep" or "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(k: string) {
  if (!isDate(k)) return '';
  const [, m, d] = k.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

const labels = (ids: readonly AreaId[], sep: string) => ids.map((id) => AREAS[id].label).join(sep);

// What the person sees after the life check-in: where they are, in plain words. The System look
// passes its own names for the coach and the tab.
export function firstRead(life: Partial<Pick<Life, 'areas' | 'grow' | 'values'>> | null | undefined, goal = '', { coach = 'Your coach', tab = 'Me' } = {}): string[] {
  if (!life) return [];
  const areas = life.areas || {};
  const low = lowest(areas);
  const high = highest(areas);
  const grow = (life.grow || []).filter(isArea);
  const values = life.values || [];
  const g = goal.trim();
  const out: string[] = low.map((id) => AREAS[id].low);
  if (high) out.push(AREAS[high].high);
  if (grow.length) out.push(`You want to grow first: ${labels(grow, ' and ')}.`);
  if (g && Object.keys(areas).length) {
    out.push(low.length ? `${coach} will help you fit “${g}” around the rest of your life, starting with ${AREAS[low[0]].focus}.` : `${coach} will help you work toward “${g}” without losing what's going well.`);
  }
  if (values.length) out.push(`What matters most to you: ${values.join(', ')}.`);
  if (out.length) out.push(`${coach} sees all of this, not just one goal. You can change it any time on the ${tab} tab.`);
  return out;
}

// What changed since the check-in before: only parts rated both times.
export function changesSince(life: Pick<Life, 'areas'> | null | undefined, before: LifeBefore | null | undefined): string {
  if (!life || !before) return '';
  const now = life.areas || {};
  const then = before.areas || {};
  const moved = AREA_IDS.filter((id) => now[id] && then[id] && now[id] !== then[id]).map((id) => `${AREAS[id].label} ${then[id]} → ${now[id]}`);
  return moved.length ? `Since ${shortDate(before.at)}: ${moved.join(', ')}.` : `Same as on ${shortDate(before.at)}.`;
}

const pad = (n: number) => String(n).padStart(2, '0');
function addDays(k: string, n: number) {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
// The days from `days` ago up to today with sleep, energy or mood, newest first.
function rated(logs: Record<string, CheckinLog> | null | undefined, today: string, days: number) {
  const from = addDays(today, -(days - 1));
  return Object.entries(logs || {})
    .filter(([k, l]) => isDate(k) && k >= from && k <= today && l && (rating(l.s) || rating(l.e) || rating(l.m)))
    .sort(([a], [b]) => (a < b ? 1 : -1));
}

// Sleep, energy and mood on average over the last 28 days (to one decimal; null with no data),
// and how many days had any of them.
export function checkinAverages(logs: Record<string, CheckinLog> | null | undefined, today: string, days = 28): { n: number; s: number | null; e: number | null; m: number | null } {
  const list = rated(logs, today, days).map(([, l]) => l);
  const avg = (f: 's' | 'e' | 'm') => {
    const xs = list.map((l) => rating(l[f])).filter(Boolean);
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
  };
  return { n: list.length, s: avg('s'), e: avg('e'), m: avg('m') };
}

const ratingsOf = (areas: Areas) =>
  AREA_IDS.filter((id) => areas[id])
    .map((id) => `${AREAS[id].label} ${areas[id]}`)
    .join(', ');

// The coach's section on the person's life: their own answers, so any AI they picked may read it
// (tier 1). The same in both looks. Compact (for small models): the ratings, where they want to
// grow, what matters, and the last 3 days of check-ins.
export function lifeLines(profile: Record<string, unknown> | null | undefined, logs: Record<string, CheckinLog> | null | undefined, today: string, { compact = false } = {}): string[] {
  const life = cleanLife(profile?.life);
  const before = cleanLifeBefore(profile?.lifeBefore);
  const out = ['## Their life right now (their own answers in Arise; 1 = hard, 5 = great)'];
  if (life) {
    const ratings = ratingsOf(life.areas);
    out.push(`Life check-in on ${life.at}: ${ratings || 'no parts rated'}.`);
    if (!compact && before && before.at < life.at) out.push(`The one before, on ${before.at}: ${ratingsOf(before.areas)}.`);
    if (life.grow.length) out.push(`They want to grow first: ${labels(life.grow, ', ')}.`);
    if (life.values.length) out.push(`What matters most to them: ${life.values.join(', ')}.`);
    const hope = life.hope.replace(/\s+/g, ' ').trim();
    if (!compact && hope) out.push(`A great next year, in their words: "${hope}"`);
  } else out.push('No life check-in yet. If it helps, ask about one part of their life you know nothing about.');
  const days = compact ? 3 : 7;
  const recent = rated(logs, today, days).map(([k, l]) => {
    const s = rating(l.s);
    const e = rating(l.e);
    const m = rating(l.m);
    return `${k} ${[s && `sleep ${s}`, e && `energy ${e}`, m && `mood ${m}`].filter(Boolean).join(', ')}`;
  });
  if (recent.length) out.push(`Daily check-ins, last ${days} days (newest first): ${recent.join('; ')}.`);
  if (!compact) {
    const a = checkinAverages(logs, today);
    const parts = [a.s != null && `sleep ${a.s.toFixed(1)}`, a.e != null && `energy ${a.e.toFixed(1)}`, a.m != null && `mood ${a.m.toFixed(1)}`].filter(Boolean);
    if (a.n) out.push(`Last 4 weeks on average (${a.n} ${a.n === 1 ? 'check-in' : 'check-ins'}): ${parts.join(', ')}.`);
  }
  return out;
}
