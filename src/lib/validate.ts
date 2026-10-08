// One gate for all data that comes from outside this running app: a backup file, the cloud copy,
// the iPhone app's data file, and even this device's own storage (which an older version or a
// browser extension could have left in a bad state).
//
// Everything is rebuilt from a whitelist: each field is type-checked, numbers are clamped, text is
// capped in length, ids must match a strict pattern, and anything unknown is dropped. Screens can
// then rely on numbers being numbers and ids being plain, so imported data can't inject HTML into
// the page or leave the app unable to start.

import { TEMPLATES } from '../program.js';
import { cleanSlot, int, isDate, isExercise, normalizePlan, str, type Plan, type Slot } from './clean';
import { cleanChecks, cleanGoal, cleanValues, type Checks, type Goal, type Values } from './goals';

export { DATE, isDate } from './clean';
const ID = /^[a-z0-9]{1,32}$/i;
const WORKOUT_ID = /^[A-Za-z0-9_]{1,24}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Kept in step with PROVIDERS in ai.js; an unknown one falls back to "work it out from the key".
const AI_PROVIDERS = ['', 'anthropic', 'google', 'openai', 'openrouter', 'groq', 'custom'];
const PHASES = ['bulk', 'cut', 'maintain'];
const MAX_SESSIONS = 20000;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null;
};
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : 0);
const bool = (v: unknown) => v === true;
const dates = (v: unknown) => [...new Set(arr(v).filter(isDate))].sort();
const strList = (v: unknown, n: number, max: number) =>
  arr(v)
    .filter((x): x is string => typeof x === 'string')
    .slice(0, n)
    .map((x) => x.slice(0, max));

export interface Settings {
  restBig: number;
  restSmall: number;
  sound: boolean;
  vibrate: boolean;
  name: string;
  remindAt: string;
  aiDaily: boolean;
  template: string;
  perWeek: number;
  notify: boolean;
  evening: boolean;
  eveningAt: string;
  aiProvider: string;
  aiModel: string;
  aiBase: string;
  aiEngine: '' | 'private' | 'device' | 'own';
  bar: 'home' | 'nearby' | 'none';
}

export function cleanSettings(raw: unknown, d: Settings): Settings {
  const s = obj(raw);
  const pick = <T>(v: unknown, ok: (x: unknown) => boolean, dflt: T): T => (ok(v) ? (v as T) : dflt);
  const isBool = (x: unknown) => typeof x === 'boolean';
  return {
    restBig: int(s.restBig ?? d.restBig, 15, 600, d.restBig),
    restSmall: int(s.restSmall ?? d.restSmall, 15, 600, d.restSmall),
    sound: pick(s.sound, isBool, d.sound),
    vibrate: pick(s.vibrate, isBool, d.vibrate),
    name: str(s.name ?? d.name, 24),
    remindAt: pick(s.remindAt, (x) => typeof x === 'string' && TIME.test(x), d.remindAt),
    aiDaily: pick(s.aiDaily, isBool, d.aiDaily),
    template: pick(s.template, (x) => typeof x === 'string' && Object.hasOwn(TEMPLATES, x), d.template),
    perWeek: int(s.perWeek ?? d.perWeek, 3, 7, d.perWeek),
    notify: pick(s.notify, isBool, d.notify),
    evening: pick(s.evening, isBool, d.evening),
    eveningAt: pick(s.eveningAt, (x) => typeof x === 'string' && TIME.test(x), d.eveningAt),
    aiProvider: pick(s.aiProvider, (x) => AI_PROVIDERS.includes(x as string), d.aiProvider),
    aiModel: pick(s.aiModel, (x) => typeof x === 'string' && /^[\w.:/@+-]{0,120}$/.test(x), d.aiModel),
    aiBase: pick(s.aiBase, (x) => typeof x === 'string' && (x === '' || /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))[^\s"'<>`]{0,300}$/.test(x)), d.aiBase),
    aiEngine: pick(s.aiEngine, (x) => ['', 'private', 'device', 'own'].includes(x as string), d.aiEngine),
    bar: pick(s.bar, (x) => ['home', 'nearby', 'none'].includes(x as string), d.bar),
  };
}

export interface SetEntry {
  r: number;
  done: boolean;
}
export interface Item {
  ex: string;
  setup: string;
  sets: SetEntry[];
}
export interface Session {
  id: string;
  workout: string;
  name?: string;
  slots?: Slot[];
  date: string;
  started: number;
  finished: number;
  easy: boolean;
  atHome?: true;
  items: Item[];
}

const reps = (v: unknown) => int(v, 0, 999, 0);

function cleanItem(raw: unknown, { done }: { done: boolean }): Item | null {
  const it = obj(raw);
  if (!isExercise(it.ex)) return null;
  const sets = arr(it.sets)
    .slice(0, 20)
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const x = s as Record<string, unknown>;
      return { r: reps(x.r), done: done ? true : bool(x.done) };
    })
    .filter((s) => !done || s.done);
  return { ex: it.ex, setup: str(it.setup, 500), sets };
}

export function cleanSession(raw: unknown): Session | null {
  const s = obj(raw);
  if (typeof s.id !== 'string' || !ID.test(s.id) || !isDate(s.date) || typeof s.workout !== 'string' || !WORKOUT_ID.test(s.workout)) return null;
  const items = arr(s.items)
    .slice(0, 20)
    .map((it) => cleanItem(it, { done: true }));
  if (items.some((it) => !it)) return null;
  const started = time(s.started);
  const out: Session = {
    id: s.id,
    workout: s.workout,
    date: s.date,
    started,
    finished: Math.max(started, time(s.finished)),
    easy: bool(s.easy),
    items: items as Item[],
  };
  if (typeof s.name === 'string' && s.name.trim()) out.name = s.name.slice(0, 40);
  if (Array.isArray(s.slots)) {
    const slots = s.slots.slice(0, 20).map((sl) => cleanSlot(sl, { keepCut: false }));
    // The saved targets must line up with the items, or they're dropped and the plan's are used.
    if (slots.every(Boolean) && slots.length === items.length) out.slots = slots as Slot[];
  }
  if (s.atHome === true) out.atHome = true;
  return out;
}

export interface Log {
  e?: number | null;
  t?: string;
  ai?: string;
  at: number;
}

function cleanLogs(raw: unknown): Record<string, Log> {
  const out: Record<string, Log> = {};
  for (const [k, v] of Object.entries(obj(raw))) {
    if (!isDate(k)) continue;
    const l = obj(v);
    const log: Log = { at: time(l.at) };
    if (l.e != null) log.e = Number.isInteger(l.e) && (l.e as number) >= 1 && (l.e as number) <= 5 ? (l.e as number) : null;
    if (typeof l.t === 'string') log.t = l.t.slice(0, 20000);
    if (typeof l.ai === 'string') log.ai = l.ai.slice(0, 4000);
    out[k] = log;
  }
  return out;
}

export interface BodyEntry {
  date: string;
  weight: number | null;
  waist: number | null;
  shoulders: number | null;
  at?: number;
}

export const cleanBodyEntry = (raw: unknown): BodyEntry | null => {
  const e = obj(raw);
  if (!isDate(e.date)) return null;
  const entry: BodyEntry = { date: e.date, weight: num(e.weight, 25, 400), waist: num(e.waist, 40, 250), shoulders: num(e.shoulders, 60, 250) };
  if (entry.weight == null && entry.waist == null && entry.shoulders == null) return null;
  if (time(e.at)) entry.at = time(e.at);
  return entry;
};

function cleanBody(raw: unknown) {
  const b = obj(raw);
  const byDate = new Map<string, BodyEntry>();
  for (const e of arr(b.entries).map(cleanBodyEntry)) if (e) byDate.set(e.date, e);
  const phase = PHASES.includes(b.phase as string) ? (b.phase as string) : null;
  return {
    phase,
    phaseSince: phase && isDate(b.phaseSince) ? b.phaseSince : null,
    entries: [...byDate.values()].sort((x, y) => (x.date < y.date ? -1 : 1)),
  };
}

function cleanProfile(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const p = obj(raw);
  const out: Record<string, unknown> = {};
  // Well above what the screens allow, so longer answers from before those limits are kept.
  for (const [k, max] of [
    ['name', 24],
    ['goal', 5000],
    ['deadline', 40],
    ['why', 5000],
    ['pistol', 30],
    ['time', 30],
    ['travel', 30],
    ['obstaclesNote', 5000],
  ] as const) {
    if (typeof p[k] === 'string') out[k] = (p[k] as string).slice(0, max);
  }
  for (const k of ['pullups', 'pushups'] as const) if (p[k] != null && Number.isFinite(Number(p[k]))) out[k] = int(p[k], 0, 999, 0);
  for (const k of ['equipment', 'obstacles', 'tone'] as const) if (Array.isArray(p[k])) out[k] = strList(p[k], 20, 60);
  for (const k of ['onboarded', 'skipped'] as const) if (p[k] === true) out[k] = true;
  if (time(p.updated)) out.updated = time(p.updated);
  return out;
}

export function cleanPlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    return normalizePlan(raw);
  } catch {
    return null;
  }
}

function cleanAI(raw: unknown) {
  const a = obj(raw);
  const daily: Record<string, { message: string; focus: string; at: number }> = {};
  for (const [k, v] of Object.entries(obj(a.daily))) {
    const d = obj(v);
    if (isDate(k) && typeof d.message === 'string') daily[k] = { message: d.message.slice(0, 1500), focus: str(d.focus, 300), at: time(d.at) };
  }
  const chat = arr(a.chat)
    .slice(-200)
    .map(obj)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: (m.text as string).slice(0, 20000), at: time(m.at), ...(m.error === true ? { error: true } : {}) }));
  const n = obj(a.nudges);
  const nudges = Array.isArray(n.messages) ? { messages: strList(n.messages, 60, 140), at: time(n.at) } : null;
  const u = obj(a.usage);
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const usage = { input: count(u.input), output: count(u.output), cacheWrite: count(u.cacheWrite), cacheRead: count(u.cacheRead), otherIn: count(u.otherIn), otherOut: count(u.otherOut), calls: count(u.calls) };
  return { daily, chat, nudges: nudges?.messages.length ? nudges : null, usage };
}

// The workout in progress. Only ever read from this device's own storage, but a bad one would
// stop the app from opening, so it gets the same care.
function cleanActive(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const a = obj(raw);
  if (typeof a.id !== 'string' || !ID.test(a.id) || typeof a.workout !== 'string' || !WORKOUT_ID.test(a.workout) || !isDate(a.date)) return null;
  const slots = arr(a.slots).map((sl) => cleanSlot(sl, { keepCut: false }));
  const items = arr(a.items).map((it) => cleanItem(it, { done: false }));
  if (!slots.length || slots.length !== items.length || slots.some((s) => !s) || items.some((i) => !i)) return null;
  const t = obj(a.timer);
  const timer =
    (t.mode === 'rest' || t.mode === 'hold') && time(t.end)
      ? { mode: t.mode, end: time(t.end), total: int(t.total, 1, 3600, 60), ...(t.mode === 'hold' ? { i: int(t.i, 0, items.length - 1, 0), j: int(t.j, 0, 19, 0) } : {}) }
      : null;
  return {
    id: a.id,
    workout: a.workout,
    name: str(a.name, 40),
    slots: slots as Slot[],
    skippedLegs: bool(a.skippedLegs),
    atHome: bool(a.atHome),
    date: a.date,
    started: time(a.started) || Date.now(),
    easy: bool(a.easy),
    focus: int(a.focus, 0, items.length - 1, 0),
    timer,
    items: items as Item[],
  };
}

// Change stamps used by sync to tell an add from a delete (see lib/merge.ts):
// collection -> key -> time, positive when the item was added, negative when it was removed.
export type Stamps = Record<string, Record<string, number>>;
const STAMPED = ['sessions', 'football', 'rests', 'easyWeeks', 'body', 'plan', 'chat', 'goals'];

function cleanStamps(raw: unknown): Stamps {
  const out: Stamps = {};
  for (const c of STAMPED) {
    const m: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj(obj(raw)[c]))) {
      if ((isDate(k) || ID.test(k)) && typeof v === 'number' && Number.isFinite(v) && v !== 0) m[k] = v;
    }
    out[c] = m;
  }
  return out;
}

function cleanGoals(raw: unknown): Goal[] {
  const today = localToday();
  const seen = new Set<string>();
  return arr(raw)
    .slice(0, 50)
    .map((g) => cleanGoal(g, today))
    .filter((g): g is Goal => !!g && !seen.has(g.id) && !!seen.add(g.id));
}

export interface State {
  v: 1;
  settings: Settings;
  sessions: Session[];
  football: string[];
  easyWeeks: string[];
  easySnooze: string | null;
  logs: Record<string, Log>;
  rests: string[];
  body: ReturnType<typeof cleanBody>;
  profile: ReturnType<typeof cleanProfile>;
  customPlan: Plan | null;
  ai: ReturnType<typeof cleanAI>;
  active: ReturnType<typeof cleanActive>;
  goals: Goal[];
  checks: Checks;
  values: Values;
  stamps: Stamps;
  updatedAt?: number;
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function cleanState(raw: unknown, defaults: Settings): State {
  const d = obj(raw);
  const byId = new Map<string, Session>();
  for (const s of arr(d.sessions).slice(-MAX_SESSIONS)) {
    const c = cleanSession(s);
    if (c) byId.set(c.id, c);
  }
  const state: State = {
    v: 1,
    settings: cleanSettings(d.settings, defaults),
    sessions: [...byId.values()].sort((x, y) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1)),
    football: dates(d.football),
    easyWeeks: dates(d.easyWeeks),
    easySnooze: isDate(d.easySnooze) ? d.easySnooze : null,
    logs: cleanLogs(d.logs),
    rests: dates(d.rests),
    body: cleanBody(d.body),
    profile: cleanProfile(d.profile),
    customPlan: cleanPlan(d.customPlan),
    ai: cleanAI(d.ai),
    active: cleanActive(d.active),
    goals: cleanGoals(d.goals),
    checks: cleanChecks(d.checks),
    values: cleanValues(d.values),
    stamps: cleanStamps(d.stamps),
  };
  if (time(d.updatedAt)) state.updatedAt = time(d.updatedAt);
  return state;
}
