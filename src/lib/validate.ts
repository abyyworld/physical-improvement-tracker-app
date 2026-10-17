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
import type { LifeEvent, LifeKind, LifeSource, LifeTier } from '../life/types';
import { LIFE_KINDS, LIFE_SOURCES, floorTier } from '../life/tiers';

export { DATE, isDate } from './clean';
const ID = /^[a-z0-9]{1,32}$/i;
const WORKOUT_ID = /^[A-Za-z0-9_]{1,24}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Kept in step with PROVIDERS in ai.js; an unknown one falls back to "work it out from the key".
export const AI_PROVIDERS = ['', 'anthropic', 'google', 'openai', 'openrouter', 'groq', 'cerebras', 'mistral', 'github', 'sambanova', 'nvidia', 'huggingface', 'cohere', 'custom'];
const AI_BASE = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))[^\s"'<>`]{0,300}$/;
const AI_MODEL = /^[\w.:/@+-]{0,120}$/;
const PHASES = ['bulk', 'cut', 'maintain'];
// How the app looks (src/look.ts): the Arise look following the device, always light or always
// dark, or 'system', the original Solo Leveling look.
export const LOOKS = ['auto', 'light', 'dark', 'system'] as const;
export type Look = (typeof LOOKS)[number];
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
  aiEngine: '' | 'private' | 'device' | 'free' | 'own';
  bar: 'home' | 'nearby' | 'none';
  dayOff: boolean;
  privateModel: string; // the private AI's model, picked by the Player; '' is the recommended one
  freeModel: string; // the same for the free AI
  look: Look;
}

export function cleanSettings(raw: unknown, d: Settings): Settings {
  const s = obj(raw);
  const pick = <T>(v: unknown, ok: (x: unknown) => boolean, dflt: T): T => (ok(v) ? (v as T) : dflt);
  const isBool = (x: unknown) => typeof x === 'boolean';
  const isModel = (x: unknown) => typeof x === 'string' && AI_MODEL.test(x);
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
    aiModel: pick(s.aiModel, isModel, d.aiModel),
    aiBase: pick(s.aiBase, (x) => typeof x === 'string' && (x === '' || AI_BASE.test(x)), d.aiBase),
    aiEngine: pick(s.aiEngine, (x) => ['', 'private', 'device', 'free', 'own'].includes(x as string), d.aiEngine),
    bar: pick(s.bar, (x) => ['home', 'nearby', 'none'].includes(x as string), d.bar),
    dayOff: pick(s.dayOff, isBool, d.dayOff),
    privateModel: pick(s.privateModel, isModel, d.privateModel),
    freeModel: pick(s.freeModel, isModel, d.freeModel),
    look: pick(s.look, (x) => LOOKS.includes(x as Look), d.look),
  };
}

// The Player's AI keys, kept on this device only (never synced or in backups). A field left out
// follows the old single-key settings (aiProvider, aiModel, aiBase), so a key saved before there
// could be many keeps working exactly as it did.
export interface AIKey {
  id: string;
  key: string;
  provider?: string;
  model?: string;
  base?: string;
  label?: string;
}
export const MAX_AI_KEYS = 20;

export function cleanAIKeys(raw: unknown): AIKey[] {
  const out: AIKey[] = [];
  for (const x of arr(raw)) {
    const k = obj(x);
    const key = typeof k.key === 'string' ? k.key.trim() : '';
    // Keys are plain tokens: no spaces, quotes or angle brackets, and not absurdly long.
    if (typeof k.id !== 'string' || !ID.test(k.id) || !/^[\x21-\x7e]{1,400}$/.test(key) || /["'<>`\\]/.test(key)) continue;
    if (out.some((o) => o.id === k.id)) continue;
    const e: AIKey = { id: k.id, key };
    if (typeof k.provider === 'string' && AI_PROVIDERS.includes(k.provider)) e.provider = k.provider;
    if (typeof k.model === 'string' && AI_MODEL.test(k.model)) e.model = k.model;
    if (typeof k.base === 'string' && (k.base === '' || AI_BASE.test(k.base))) e.base = k.base;
    if (typeof k.label === 'string' && k.label.trim()) e.label = k.label.trim().slice(0, 40);
    out.push(e);
    if (out.length >= MAX_AI_KEYS) break;
  }
  return out;
}

// Why a key is resting, and until when (see lib/free-ai.ts). `until` is 0 for a key that waits
// until the Player edits or tests it.
export type CoolWhy = 'minute' | 'day' | 'week' | 'month' | 'busy' | 'model' | 'key' | 'credit';
export interface AICool {
  why: CoolWhy;
  until: number;
  at: number;
  note?: string;
}
const COOL_WHY: CoolWhy[] = ['minute', 'day', 'week', 'month', 'busy', 'model', 'key', 'credit'];

export function cleanAICools(raw: unknown): Record<string, AICool> {
  const out: Record<string, AICool> = {};
  for (const [id, x] of Object.entries(obj(raw)).slice(0, MAX_AI_KEYS * 2)) {
    const c = obj(x);
    if (!ID.test(id) || !COOL_WHY.includes(c.why as CoolWhy)) continue;
    const cool: AICool = { why: c.why as CoolWhy, until: time(c.until), at: time(c.at) };
    if (typeof c.note === 'string' && /^[a-z-]{1,24}$/.test(c.note)) cool.note = c.note;
    out[id] = cool;
  }
  return out;
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
    // tier: the highest tier of the life log a reply was made from (see ai.js, chat).
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: (m.text as string).slice(0, 20000), at: time(m.at), ...(m.error === true ? { error: true } : {}), ...(m.role === 'assistant' && (m.tier === 2 || m.tier === 3) ? { tier: m.tier as 2 | 3 } : {}) }));
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
const STAMPED = ['sessions', 'football', 'rests', 'easyWeeks', 'body', 'plan', 'chat', 'goals', 'planDays'];

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

// Each goal as lib/goals.ts cleans it, its share link included: kept only as a 22-character id,
// a 43-character key and a time, all checked (lib/share.ts), or dropped.
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

// Only the fields below are kept. The app lock (lib/lock.ts) is never one of them: it lives
// under its own key on each device, so a backup or the cloud copy can't carry one in or out.
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

// ---------- the life log (src/life): events, and what Arise learns from them

// `${source}:` and then the source's own id or a hash: printable ASCII, no spaces. Anything that
// isn't safe in a key is the importer's to hash.
const LIFE_ID = /^[a-z]{2,12}:[\x21-\x7e]{1,240}$/;
const META_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const LIFE_MAX_TIME = Date.UTC(2200, 0, 1);
// Text from an export can hold anything: control characters go, runs of spaces become one.
const oneLine = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const manyLines = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, max)
    : '';
const lifeTime = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < LIFE_MAX_TIME ? Math.round(v) : 0);
const isTier = (v: unknown): v is LifeTier => v === 1 || v === 2 || v === 3;

// One event for the life log, or null when it can't be used. The tier is never lower than its
// kind allows (life/tiers.ts), whatever the importer said; with no tier, it's the most private.
export function cleanLifeEvent(raw: unknown): LifeEvent | null {
  const e = obj(raw);
  const source = e.source as LifeSource;
  const kind = e.kind as LifeKind;
  if (!LIFE_SOURCES.includes(source) || !LIFE_KINDS.includes(kind)) return null;
  if (typeof e.id !== 'string' || !LIFE_ID.test(e.id) || !e.id.startsWith(`${source}:`)) return null;
  const at = lifeTime(e.at);
  const title = oneLine(e.title, 300);
  if (!at || !title) return null;
  const given = isTier(e.tier) ? e.tier : 3;
  const tier = Math.max(given, floorTier(source, kind)) as LifeTier;
  const out: LifeEvent = { id: e.id, source, kind, at, title, tier };
  const end = lifeTime(e.end);
  if (end >= at) out.end = end;
  const detail = manyLines(e.detail, 4000);
  if (detail) out.detail = detail;
  if (typeof e.url === 'string' && /^https?:\/\/[^\s"'<>`]{1,2000}$/i.test(e.url)) out.url = e.url;
  if (typeof e.value === 'number' && Number.isFinite(e.value) && Math.abs(e.value) < 1e12) out.value = e.value;
  const unit = oneLine(e.unit, 24);
  if (unit) out.unit = unit;
  const meta: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj(e.meta)).slice(0, 30)) {
    if (!META_KEY.test(k)) continue;
    if (typeof v === 'string') meta[k] = oneLine(v, 500);
    else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) meta[k] = v;
  }
  if (Object.keys(meta).length) out.meta = meta;
  return out;
}

// Something Arise knows about the Player: learned by the AI from their days, or added by them.
export interface LifeFact {
  id: string;
  text: string;
  since: string; // the day it was learned or added
  until?: string; // the day it stopped being true (retired), if it has
  from: 'ai' | 'you';
  pinned?: true;
  tier: LifeTier; // the highest tier of what it came from
  sources: string[]; // the days it came from or was confirmed by, oldest first
  at: number; // last changed
}

const FACT_ID = /^f[a-z0-9]{1,24}$/;
export const FACT_MAX = 240;

export function cleanLifeFact(raw: unknown): LifeFact | null {
  const f = obj(raw);
  const text = oneLine(f.text, FACT_MAX);
  if (typeof f.id !== 'string' || !FACT_ID.test(f.id) || !text || !isDate(f.since)) return null;
  const from = f.from === 'you' ? 'you' : 'ai';
  const sources = [...new Set(arr(f.sources).filter(isDate))].sort().slice(-60);
  const out: LifeFact = { id: f.id, text, since: f.since, from, tier: isTier(f.tier) ? f.tier : 3, sources, at: time(f.at) };
  if (isDate(f.until) && f.until >= f.since) out.until = f.until;
  if (f.pinned === true) out.pinned = true;
  return out;
}

// A summary of a day, a week (key: its Monday) or a month (key: 2026-10).
export interface LifeSummary {
  id: string; // 'd:2026-10-16', 'w:2026-10-12' or 'm:2026-10'
  kind: 'day' | 'week' | 'month';
  key: string;
  text: string;
  tier: LifeTier; // the highest tier of what it came from
  cap: LifeTier; // the highest tier the AI that wrote it was allowed to see
  sig: string; // a fingerprint of what it came from, to tell when it's out of date
  n: number; // how many things it came from
  at: number;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function cleanLifeSummary(raw: unknown): LifeSummary | null {
  const s = obj(raw);
  const kind = s.kind === 'day' || s.kind === 'week' || s.kind === 'month' ? s.kind : null;
  const key = s.key;
  if (!kind || typeof key !== 'string' || !(kind === 'month' ? MONTH.test(key) : isDate(key))) return null;
  const id = `${kind[0]}:${key}`;
  if (s.id !== id) return null;
  const text = manyLines(s.text, 1500);
  if (!text) return null;
  const tier = isTier(s.tier) ? s.tier : 3;
  return { id, kind, key, text, tier, cap: isTier(s.cap) ? (Math.max(s.cap, tier) as LifeTier) : tier, sig: str(s.sig, 40), n: int(s.n, 0, 1e7, 0), at: time(s.at) };
}

// The life log's switches. "Stop learning" syncs between the Player's devices (with when it was
// last changed, so the newest choice wins); letting less private AIs read the log stays on each
// device, like the choice of AI.
export interface LifePrefs {
  lessPrivate: boolean; // less private AIs (the free AI, your own service) may read tiers 2 and 3
  paused: boolean; // "Stop learning": no new summaries or facts
  pausedAt?: number; // when `paused` last changed (none: never)
}

export function cleanLifePrefs(raw: unknown): LifePrefs {
  const p = obj(raw);
  const out: LifePrefs = { lessPrivate: p.lessPrivate === true, paused: p.paused === true };
  if (time(p.pausedAt)) out.pausedAt = time(p.pausedAt);
  return out;
}

// ---------- the life log's sync (src/life/packs.ts)

// Something the Player deleted from the life log in one go, kept so every device deletes it too:
// everything ('all'), the log only ('events': all of it, one source, a span of time, or both), or
// what Arise learned ('memory'). It covers what was there at `at`, never what came later.
export interface LifeWipe {
  at: number;
  what: 'all' | 'events' | 'memory';
  source?: LifeSource;
  from?: number;
  to?: number;
}

export function cleanLifeWipe(raw: unknown): LifeWipe | null {
  const w = obj(raw);
  const at = time(w.at);
  if (!at || (w.what !== 'all' && w.what !== 'events' && w.what !== 'memory')) return null;
  const out: LifeWipe = { at, what: w.what };
  if (w.what !== 'events') return out;
  if (w.source !== undefined) {
    if (!LIFE_SOURCES.includes(w.source as LifeSource)) return null;
    out.source = w.source as LifeSource;
  }
  // A span of time. An end that isn't a number drops the whole wipe, rather than let it stand
  // for "all of it".
  for (const k of ['from', 'to'] as const) {
    if (w[k] === undefined) continue;
    if (typeof w[k] !== 'number' || !Number.isFinite(w[k])) return null;
    out[k] = w[k] as number;
  }
  return out;
}

// A pack's name (src/life/packs.ts): a month of events, a year of summaries, or the memory.
const LIFE_PACK = /^(mem|e:\d{4}-(0[1-9]|1[0-2])|s:\d{4})$/;
const LIFE_REV = /^[A-Za-z0-9_-]{1,40}$/;
const LIFE_MAX_PARTS = 12;

export interface LifePackInfo {
  r: string; // its version
  n: number; // how many parts
}
// Which packs the cloud has (the sealed index). `seq` goes up by one with each version, so an
// older one put back in the cloud is told apart (life/cloud.ts).
export interface LifeIndex {
  schema: number;
  seq: number;
  packs: Record<string, LifePackInfo>;
}

const packInfos = (raw: unknown, extra: (v: Record<string, unknown>) => Record<string, unknown> = () => ({})) => {
  const out: Record<string, LifePackInfo & Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj(raw)).slice(0, 5000)) {
    const p = obj(v);
    if (!LIFE_PACK.test(k) || typeof p.r !== 'string' || !LIFE_REV.test(p.r)) continue;
    if (!Number.isInteger(p.n) || (p.n as number) < 1 || (p.n as number) > LIFE_MAX_PARTS) continue;
    out[k] = { r: p.r, n: p.n as number, ...extra(p) };
  }
  return out;
};

export function cleanLifeIndex(raw: unknown): LifeIndex {
  const d = obj(raw);
  return { schema: int(d.schema, 1, 1000, 1), seq: int(d.seq, 0, Number.MAX_SAFE_INTEGER, 0), packs: packInfos(d.packs) };
}

// What this device knows of an account's life log in the cloud (src/life/local.ts).
export interface LifeSyncState {
  uid: string;
  idx: string; // the index version (its IV) last seen
  seq: number; // and the highest `seq` of it seen
  packs: Record<string, LifePackInfo & { h: string; at: number }>; // h: fingerprint of its content; at: when synced
}

export function cleanLifeSyncState(raw: unknown): LifeSyncState | null {
  const d = obj(raw);
  if (typeof d.uid !== 'string' || !d.uid || d.uid.length > 128) return null;
  const packs = packInfos(d.packs, (p) => ({ h: str(p.h, 64), at: time(p.at) })) as unknown as LifeSyncState['packs'];
  return { uid: d.uid, idx: str(d.idx, 40), seq: int(d.seq, 0, Number.MAX_SAFE_INTEGER, 0), packs };
}

// What was deleted one by one: id -> when. The ids are the items' own (an event's, a fact's or a
// summary's), within the same limits.
const TOMB_ID = /^[\x21-\x7e]{1,260}$/;
export function cleanLifeTombs(raw: unknown, max = 200000): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const [id, m] of Object.entries(obj(raw))) {
    if (n >= max) break;
    if (!TOMB_ID.test(id) || !time(m)) continue;
    out[id] = time(m);
    n++;
  }
  return out;
}
