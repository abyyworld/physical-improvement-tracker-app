// Goals in any part of life, and the daily quests that move them.
//
// A goal (learn Spanish, save $10k, run a half marathon, get a dev job, build a physique...) has:
//   - quests: the recurring actions that get it done. Daily, on set weekdays, or a number of times
//     a week. Either just "done", or an amount (30 min, 20 pages, 5 km);
//   - measures: numbers that show progress (savings, a test score, weight), with a target;
//   - milestones: checkpoints on the way.
// A fitness goal can also use Arise's home workout plan (the A/B/C rotation with sets, reps and a
// rest timer); that lives in the rest of the store as before.
//
// Ticks are kept apart from the goals (state.checks: date -> quest -> tick), and so are measure
// values (state.values: measure -> date -> value), so two devices can each tick things off and
// edit goals without overwriting each other.

import { int, isDate, plain, str } from './clean';
import { cleanShareRef, type ShareRef } from './share';

export const CATEGORIES = {
  fitness: { label: 'Fitness', stat: 'vit' },
  learning: { label: 'Learning', stat: 'int' },
  career: { label: 'Career', stat: 'int' },
  money: { label: 'Money', stat: 'int' },
  health: { label: 'Health', stat: 'sen' },
  mind: { label: 'Mind', stat: 'sen' },
  creative: { label: 'Creative', stat: 'int' },
  relationships: { label: 'People', stat: 'sen' },
  habits: { label: 'Habits', stat: 'sen' },
  other: { label: 'Other', stat: 'sen' },
} as const;
export type Category = keyof typeof CATEGORIES;
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && Object.hasOwn(CATEGORIES, v);

export type Schedule = { kind: 'daily' } | { kind: 'days'; days: number[] } | { kind: 'weekly'; times: number };

export interface Quest {
  id: string;
  title: string;
  how?: string;
  schedule: Schedule;
  amount?: { target: number; unit: string };
  created: string; // date key: not due before this
  archived?: string; // date key: not due from this day on
}

export interface Measure {
  id: string;
  name: string;
  unit: string;
  start?: number;
  target?: number;
  better: 'up' | 'down';
}

export interface Milestone {
  id: string;
  title: string;
  due?: string;
  done?: string;
}

export interface Goal {
  id: string;
  title: string;
  category: Category;
  why: string;
  by: string; // when, in the Player's words: "June 2027", "6 months"
  created: string;
  updated: number;
  status: 'active' | 'paused' | 'done';
  workouts?: true; // uses the home workout plan
  share?: ShareRef; // its progress is shared with a link (share.ts)
  quests: Quest[];
  measures: Measure[];
  milestones: Milestone[];
}

export interface Check {
  done: boolean;
  amount?: number;
  at: number;
}
export type Checks = Record<string, Record<string, Check>>; // date -> quest id -> tick
export type Values = Record<string, Record<string, { v: number; at: number }>>; // measure id -> date -> value

const ID = /^[a-z0-9]{1,32}$/i;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max: number) => plain(str(v, max * 2)).trim().slice(0, max);
const finite = (v: unknown, lo = -1e12, hi = 1e12) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : undefined;
};

// ---------- cleaning (for backups, the cloud and AI answers)

export function cleanSchedule(raw: unknown): Schedule {
  const s = obj(raw);
  if (s.kind === 'days') {
    const days = [...new Set(arr(s.days).map((d) => int(d, -1, 7, -1)))].filter((d) => d >= 0 && d <= 6).sort();
    if (days.length && days.length < 7) return { kind: 'days', days };
    if (days.length === 7) return { kind: 'daily' };
  }
  if (s.kind === 'weekly') return { kind: 'weekly', times: int(s.times, 1, 7, 3) };
  return { kind: 'daily' };
}

export function cleanQuest(raw: unknown, today: string): Quest | null {
  const q = obj(raw);
  const title = text(q.title, 80);
  if (!title) return null;
  const quest: Quest = { id: isId(q.id) ? q.id : newId(), title, schedule: cleanSchedule(q.schedule), created: isDate(q.created) ? q.created : today };
  const how = text(q.how, 300);
  if (how) quest.how = how;
  const a = obj(q.amount);
  const target = finite(a.target, 0.01, 1e6);
  if (target != null) quest.amount = { target, unit: text(a.unit, 16) || 'times' };
  if (isDate(q.archived)) quest.archived = q.archived;
  return quest;
}

export function cleanMeasure(raw: unknown): Measure | null {
  const m = obj(raw);
  const name = text(m.name, 40);
  if (!name) return null;
  const out: Measure = { id: isId(m.id) ? m.id : newId(), name, unit: text(m.unit, 12), better: m.better === 'down' ? 'down' : 'up' };
  const start = finite(m.start);
  const target = finite(m.target);
  if (start != null) out.start = start;
  if (target != null) out.target = target;
  return out;
}

export function cleanMilestone(raw: unknown): Milestone | null {
  const m = obj(raw);
  const title = text(m.title, 120);
  if (!title) return null;
  const out: Milestone = { id: isId(m.id) ? m.id : newId(), title };
  if (isDate(m.due)) out.due = m.due;
  if (isDate(m.done)) out.done = m.done;
  return out;
}

const unique = <T extends { id: string }>(list: (T | null)[], max: number): T[] => {
  const seen = new Set<string>();
  return list.filter((x): x is T => !!x && !seen.has(x.id) && !!seen.add(x.id)).slice(0, max);
};

export function cleanGoal(raw: unknown, today: string): Goal | null {
  const g = obj(raw);
  const title = text(g.title, 120);
  if (!title || !isId(g.id)) return null;
  const goal: Goal = {
    id: g.id,
    title,
    category: isCategory(g.category) ? g.category : 'other',
    why: text(g.why, 5000),
    by: text(g.by, 40),
    created: isDate(g.created) ? g.created : today,
    updated: typeof g.updated === 'number' && Number.isFinite(g.updated) ? g.updated : 0,
    status: g.status === 'paused' || g.status === 'done' ? g.status : 'active',
    quests: unique(arr(g.quests).map((q) => cleanQuest(q, today)), 30),
    measures: unique(arr(g.measures).map(cleanMeasure), 10),
    milestones: unique(arr(g.milestones).map(cleanMilestone), 30),
  };
  if (g.workouts === true) goal.workouts = true;
  const share = cleanShareRef(g.share);
  if (share) goal.share = share;
  return goal;
}

export function cleanChecks(raw: unknown): Checks {
  const out: Checks = {};
  for (const [k, day] of Object.entries(obj(raw))) {
    if (!isDate(k)) continue;
    const d: Record<string, Check> = {};
    for (const [qid, c] of Object.entries(obj(day))) {
      if (!isId(qid)) continue;
      const x = obj(c);
      const check: Check = { done: x.done === true, at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0 };
      const amount = finite(x.amount, 0, 1e6);
      if (amount != null) check.amount = amount;
      d[qid] = check;
    }
    if (Object.keys(d).length) out[k] = d;
  }
  return out;
}

export function cleanValues(raw: unknown): Values {
  const out: Values = {};
  for (const [mid, days] of Object.entries(obj(raw))) {
    if (!isId(mid)) continue;
    const m: Record<string, { v: number; at: number }> = {};
    for (const [k, e] of Object.entries(obj(days))) {
      const x = obj(e);
      const v = finite(x.v);
      if (isDate(k) && v != null) m[k] = { v, at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0 };
    }
    if (Object.keys(m).length) out[mid] = m;
  }
  return out;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- schedule maths (weekday 0 = Monday)

const weekday = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

export const live = (q: Quest, k: string) => q.created <= k && (!q.archived || k < q.archived);

// Is this quest one of the day's must-dos? Weekly quests ("3 times a week") never are: any day
// will do, and they're counted by the week.
export function dueOn(q: Quest, k: string) {
  if (!live(q, k)) return false;
  if (q.schedule.kind === 'daily') return true;
  if (q.schedule.kind === 'days') return q.schedule.days.includes(weekday(k));
  return false;
}

// Shown on the day's list: due quests, and weekly ones while they're still open (or done today).
export function showOn(q: Quest, k: string, doneThisWeek: number, doneToday: boolean) {
  if (!live(q, k)) return false;
  if (q.schedule.kind !== 'weekly') return dueOn(q, k);
  return doneToday || doneThisWeek < q.schedule.times;
}

export const isDone = (checks: Checks, k: string, qid: string) => !!checks[k]?.[qid]?.done;

export function scheduleText(s: Schedule) {
  if (s.kind === 'daily') return 'every day';
  if (s.kind === 'weekly') return s.times === 1 ? 'once a week' : `${s.times} times a week`;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (s.days.join() === '0,1,2,3,4') return 'weekdays';
  if (s.days.join() === '5,6') return 'weekends';
  return s.days.map((d) => names[d]).join(', ');
}

// ---------- starting points for each kind of goal

type Template = { quests: Omit<Quest, 'id' | 'created'>[]; measures?: Omit<Measure, 'id'>[]; examples: string[] };

export const TEMPLATES: Record<Category, Template> = {
  fitness: {
    examples: ['Build an athletic physique', 'Run a half marathon', 'Do 20 strict pull-ups'],
    quests: [
      { title: 'Train', schedule: { kind: 'weekly', times: 4 } },
      { title: 'Walk', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' } },
      { title: 'Stretch', schedule: { kind: 'daily' }, amount: { target: 10, unit: 'min' } },
    ],
    measures: [{ name: 'Weight', unit: 'kg', better: 'down' }],
  },
  learning: {
    examples: ['Learn Spanish to B2', 'Pass my exams', 'Learn to code'],
    quests: [
      { title: 'Study', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' } },
      { title: 'Review flashcards', schedule: { kind: 'daily' } },
      { title: 'Practice test', schedule: { kind: 'weekly', times: 1 } },
    ],
    measures: [{ name: 'Practice test score', unit: '%', better: 'up' }],
  },
  career: {
    examples: ['Get a software developer job', 'Get promoted this year', 'Start my own business'],
    quests: [
      { title: 'Deep work', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] }, amount: { target: 90, unit: 'min' } },
      { title: 'Apply or reach out', schedule: { kind: 'weekly', times: 3 } },
      { title: 'Plan tomorrow', schedule: { kind: 'days', days: [0, 1, 2, 3, 4] } },
    ],
    measures: [{ name: 'Applications sent', unit: '', better: 'up' }],
  },
  money: {
    examples: ['Save $10,000', 'Pay off my debt', 'Build an emergency fund'],
    quests: [
      { title: 'Log what I spent', schedule: { kind: 'daily' } },
      { title: 'No-spend day', schedule: { kind: 'weekly', times: 2 } },
      { title: 'Check my budget', schedule: { kind: 'weekly', times: 1 } },
    ],
    measures: [{ name: 'Savings', unit: '$', better: 'up' }],
  },
  health: {
    examples: ['Sleep 8 hours a night', 'Lose 10 kg', 'Eat healthier'],
    quests: [
      { title: 'Lights out on time', schedule: { kind: 'daily' } },
      { title: 'Steps', schedule: { kind: 'daily' }, amount: { target: 8000, unit: 'steps' } },
      { title: 'Water', schedule: { kind: 'daily' }, amount: { target: 2, unit: 'litres' } },
    ],
    measures: [{ name: 'Weight', unit: 'kg', better: 'down' }],
  },
  mind: {
    examples: ['Be calmer and more focused', 'Beat procrastination', 'Read 24 books this year'],
    quests: [
      { title: 'Meditate', schedule: { kind: 'daily' }, amount: { target: 10, unit: 'min' } },
      { title: 'Read', schedule: { kind: 'daily' }, amount: { target: 20, unit: 'pages' } },
      { title: 'No phone for the first hour', schedule: { kind: 'daily' } },
    ],
    measures: [{ name: 'Books finished', unit: '', better: 'up' }],
  },
  creative: {
    examples: ['Write a novel', 'Release an album', 'Get good at drawing'],
    quests: [
      { title: 'Create', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' } },
      { title: 'Share something', schedule: { kind: 'weekly', times: 1 } },
    ],
    measures: [{ name: 'Words written', unit: 'words', better: 'up' }],
  },
  relationships: {
    examples: ['Be a better friend', 'Call my family more', 'Meet new people'],
    quests: [
      { title: 'Reach out to someone', schedule: { kind: 'weekly', times: 3 } },
      { title: 'Quality time, phones away', schedule: { kind: 'weekly', times: 2 } },
    ],
  },
  habits: {
    examples: ['Quit social media scrolling', 'Wake up at 6', 'Stop smoking'],
    quests: [
      { title: 'Up at my wake-up time', schedule: { kind: 'daily' } },
      { title: 'Kept the habit today', schedule: { kind: 'daily' } },
    ],
  },
  other: {
    examples: ['Lock in every day', 'Finish what I start'],
    quests: [{ title: 'Work on it', schedule: { kind: 'daily' }, amount: { target: 30, unit: 'min' } }],
  },
};
