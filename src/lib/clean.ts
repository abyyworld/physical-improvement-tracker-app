// Cleaning text and plans that come from outside the app (AI answers, backups, the cloud), so
// the rest of the app can trust their shape.

import { EXERCISES } from '../program.js';

type Exercise = { name: string; timed?: boolean; unit?: string };
const EX = EXERCISES as Record<string, Exercise>;
export const isExercise = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(EX, id);

// Nothing the Player reads should contain long dashes: they read as machine-written.
export function plain(text: unknown): string {
  return String(text ?? '')
    .replace(/^([ \t]*)[—–][ \t]*/gm, '$1- ')
    .replace(/(\d)[ \t]*[–—][ \t]*(\d)/g, '$1-$2')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/[ \t]+–[ \t]+/g, ', ')
    .replace(/[–—]/g, '-');
}

export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v);

export const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export interface Slot {
  ex: string;
  sets: number;
  cut?: number;
  min?: number;
  max?: number;
  amrap?: true;
  unit?: 'sec' | 'sprints';
  perLeg?: true;
  note?: string;
  from?: string; // the bar exercise this home version replaces
}

// One exercise in a plan, or null if it can't be used.
export function cleanSlot(sl: unknown, { keepCut = true } = {}): Slot | null {
  if (!sl || typeof sl !== 'object') return null;
  const s = sl as Record<string, unknown>;
  if (!isExercise(s.ex)) return null;
  const ex = EX[s.ex];
  const unit = ex.timed ? 'sec' : ex.unit || 'reps';
  const slot: Slot = { ex: s.ex, sets: int(s.sets, 1, 6, 3) };
  if (keepCut && s.cut != null) slot.cut = int(s.cut, 1, slot.sets, slot.sets);
  if (s.amrap && unit === 'reps') slot.amrap = true;
  else {
    const hi = unit === 'sec' ? 180 : 100;
    slot.min = int(s.min, 1, hi, unit === 'sec' ? 30 : 8);
    slot.max = int(s.max, slot.min, hi, slot.min);
  }
  if (unit !== 'reps') slot.unit = unit as 'sec' | 'sprints';
  if (s.perLeg) slot.perLeg = true;
  const note = plain(s.note || '').trim().slice(0, 400);
  if (note) slot.note = note;
  if (isExercise(s.from)) slot.from = s.from;
  return slot;
}

export interface Workout {
  name: string;
  short: string;
  tag: string;
  legs: boolean;
  slots: Slot[];
}

export interface Plan {
  workouts: Record<string, Workout>;
  mode: 'rotation' | 'week';
  order: string[];
  week?: string[];
  perWeek?: number;
  summary: string;
  changes: string[];
  created?: number;
}

export class PlanError extends Error {
  readonly code = 'format';
}

const workoutId = (v: unknown) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'session';

// Check and clean up a plan (from the AI, a backup or the cloud) so the app can always use it.
// `raw.workouts` may be a list with ids (from the AI) or an object keyed by id (a saved plan).
export function normalizePlan(raw: unknown): Plan {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.workouts)
    ? r.workouts
    : r.workouts && typeof r.workouts === 'object'
      ? Object.entries(r.workouts as Record<string, object>).map(([id, w]) => ({ ...w, id }))
      : null;
  if (!list) throw new PlanError('The AI sent a plan the app could not read. Try again.');
  const workouts: Record<string, Workout> = {};
  const idMap = new Map<unknown, string>();
  for (const wk of list.slice(0, 8)) {
    if (!wk || typeof wk !== 'object' || !Array.isArray((wk as { slots?: unknown }).slots)) continue;
    const w = wk as Record<string, unknown> & { slots: unknown[] };
    const slots = w.slots.slice(0, 10).map((s) => cleanSlot(s)).filter((s): s is Slot => !!s);
    if (!slots.length) continue;
    let id = workoutId(w.id);
    const base = id;
    for (let n = 2; Object.hasOwn(workouts, id); n++) id = `${base}_${n}`;
    idMap.set(w.id, id);
    const name = plain(w.name || '').trim().slice(0, 40) || 'Session';
    const short = plain(w.short || '').trim().slice(0, 12) || name.split(/[\s,&]+/)[0];
    workouts[id] = { name, short, tag: plain(w.tag || '').trim().slice(0, 60), legs: !!w.legs, slots };
  }
  if (!Object.keys(workouts).length) throw new PlanError('The AI sent a plan with no usable exercises. Try again.');
  const resolve = (v: unknown) => {
    const id = idMap.get(v) ?? (typeof v === 'string' && Object.hasOwn(workouts, v) ? v : null);
    return id && Object.hasOwn(workouts, id) ? id : null;
  };
  const summary = plain(r.summary || '').trim().slice(0, 800);
  const changes = Array.isArray(r.changes) ? r.changes.map((c) => plain(c).trim().slice(0, 240)).filter(Boolean).slice(0, 12) : [];
  const created = typeof r.created === 'number' && Number.isFinite(r.created) ? { created: r.created } : {};
  if (r.mode === 'rotation') {
    const order = [...new Set((Array.isArray(r.order) ? r.order : []).map(resolve).filter((x): x is string => !!x))];
    return { workouts, mode: 'rotation', order: order.length ? order : Object.keys(workouts), perWeek: int(r.perWeek, 3, 6, 5), summary, changes, ...created };
  }
  const days = Array.isArray(r.week) ? r.week : [];
  const week = Array.from({ length: 7 }, (_, i) => (days[i] === 'rest' ? 'rest' : resolve(days[i]) || 'rest'));
  if (!week.some((d) => d !== 'rest')) throw new PlanError('The AI sent a plan with no training days. Try again.');
  return { workouts, mode: 'week', week, order: Object.keys(workouts), summary, changes, ...created };
}
