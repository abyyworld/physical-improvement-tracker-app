// Saved data, date helpers and the numbers behind streaks and progress.
// Everything lives in localStorage on this device; sync.ts keeps an encrypted copy in the cloud.

import { TEMPLATES as TEMPLATES_JS, EXERCISES as EXERCISES_JS, BAR_SWAPS as BAR_SWAPS_JS } from './program.js';
import { cleanBodyEntry, cleanState, type BodyEntry, type Item, type Session, type Settings, type State } from './lib/validate';
import type { Plan, Slot, Workout } from './lib/clean';
import * as G from './lib/goals';
import type { Goal, Quest } from './lib/goals';

export type { Goal, Quest };

export type { State, Session, Settings };

interface Template {
  id: string;
  label: string;
  mode: 'rotation' | 'week';
  workouts: Record<string, Workout>;
  order?: string[];
  week?: string[];
  rules?: string[];
  perWeek?: number;
}
interface Exercise {
  name: string;
  kind: 'big' | 'small';
  stat: 'str' | 'agi' | 'vit';
  timed?: boolean;
  unit?: string;
}
const TEMPLATES = TEMPLATES_JS as unknown as Record<string, Template>;
const EXERCISES = EXERCISES_JS as unknown as Record<string, Exercise>;
const BAR_SWAPS = BAR_SWAPS_JS as unknown as Record<string, { ex: string; min: number; max: number; note: string }>;

const KEY = 'pit-data-v1';

export const DEFAULT_SETTINGS: Settings = { restBig: 120, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00', aiDaily: true, template: 'ab', perWeek: 5, notify: false, evening: true, eveningAt: '20:30', aiProvider: '', aiModel: '', aiBase: '', aiEngine: '', bar: 'home' };

export const blank = (): State => cleanState({}, DEFAULT_SETTINGS);
export const clean = (data: unknown): State => migrate(cleanState(data, DEFAULT_SETTINGS));

// Data from before goals: the workouts become a fitness goal (with the same id on every device,
// so two devices upgrading at once end up with one goal). Not again if the Player deleted it.
function migrate(s: State): State {
  const hasFitness = s.sessions.length || s.football.length || s.customPlan || s.body.entries.length || (s.profile?.goal && !s.profile?.skipped);
  if (s.goals.length || !hasFitness || s.stamps.goals?.fitness) return s;
  const p = s.profile || {};
  const by = typeof p.deadline === 'string' && p.deadline !== 'No deadline' ? p.deadline : '';
  const first = [...s.sessions.map((x) => x.date), ...s.football].sort()[0];
  const now = new Date(); // (runs while the store is loading, before the date helpers below exist)
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // A long goal from the old intro becomes a short title (the whole text stays in the profile).
  let title = String(p.goal || '').trim() || 'Get fit with home workouts';
  if (title.length > 120) title = `${title.slice(0, 119).replace(/\s+\S*$/, '')}…`;
  const goal = G.cleanGoal({ id: 'fitness', title, category: 'fitness', why: p.why || '', by, created: first, updated: 0, workouts: true }, today);
  return goal ? { ...s, goals: [goal] } : s;
}

let fresh = false;
let problem: '' | 'corrupt' | 'full' = '';
export let state: State = load();

// True when this device had no saved data at start (the iOS app then checks its backup file).
export const freshStart = () => fresh;
// Something went wrong reading or writing this device's storage; the app tells the Player once.
export const storageProblem = () => problem;

function load(): State {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return blank();
  }
  if (!raw) {
    fresh = true;
    return blank();
  }
  try {
    return clean(JSON.parse(raw));
  } catch {
    // Unreadable: keep it under another name instead of writing over it, so it can still be rescued.
    problem = 'corrupt';
    try {
      localStorage.setItem(`${KEY}-unreadable-${Date.now()}`, raw);
    } catch {}
    return blank();
  }
}

const listeners: (() => void)[] = [];
export const onSave = (fn: () => void) => listeners.push(fn);

// Every change is stamped with the time, so account sync can tell which copy is newer.
// `touch: false` saves without counting as a change (used when taking in synced data).
export function save({ touch = true } = {}): boolean {
  if (touch) state.updatedAt = Date.now();
  let ok = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (problem === 'full') problem = '';
  } catch {
    ok = false;
    problem = 'full';
  }
  for (const fn of listeners) fn();
  return ok;
}

export const snapshot = () => JSON.stringify(state);

// The iOS app keeps a copy of the data in a file. If the phone ever clears the app's web
// storage, this puts the copy back (the page then reloads). The file sits where the Player can
// edit it, so it's checked like any import.
export function restoreSnapshot(text: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { sessions?: unknown }).sessions)) return false;
  localStorage.setItem(KEY, JSON.stringify(clean(data)));
  return true;
}

// Take in data from the cloud. `keep` lists fields that stay as they are on this device.
export function adoptState(data: object, { keep = {} }: { keep?: Partial<State> } = {}) {
  state = clean({ ...data, ...keep });
  save({ touch: false });
}

// ---------- change stamps (so sync can tell a delete from an add; see lib/merge.ts)

export function stamp(collection: string, key: string, present: boolean) {
  const m = (state.stamps[collection] ||= {});
  m[key] = present ? Date.now() : -Date.now();
}

// ---------- dates (all local time, keys look like 2026-09-29)

const pad = (n: number) => String(n).padStart(2, '0');
export const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => keyOf(new Date());
export function parseKey(k: string) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(k: string, n: number) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
export const daysBetween = (a: string, b: string) => Math.round((parseKey(b).getTime() - parseKey(a).getTime()) / 86400000);
export const weekdayIdx = (k: string) => (parseKey(k).getDay() + 6) % 7; // Monday = 0
export const mondayOf = (k: string) => addDays(k, -weekdayIdx(k));

// ---------- the plan (a template, or the one personalised by the AI coach)
// 'rotation' plans (like A/B/C) are done in order on any day; 'week' plans use fixed weekdays.

export const plan = (): Template | Plan => state.customPlan || TEMPLATES[state.settings.template] || TEMPLATES.ab;
export const planMode = () => (plan().mode === 'rotation' ? 'rotation' : 'week');
export const workouts = () => plan().workouts;
export const workoutOrder = () => plan().order || Object.keys(plan().workouts);
export const week = () => plan().week || null;
export const planRules = () => (plan() as Template).rules || TEMPLATES[planMode() === 'rotation' ? 'ab' : 'weekly'].rules || [];
export const isCustomPlan = () => !!state.customPlan;

// Training sessions per week: the user's target on a rotation, the plan's training days on a weekly plan.
export function perWeek() {
  if (planMode() === 'week') return week()!.filter((w) => w !== 'rest' && workouts()[w]).length;
  return Math.min(7, Math.max(3, Math.round(Number(state.settings.perWeek)) || 5));
}

// Names and targets survive plan changes: sessions keep a copy of what was prescribed.
const knownWorkout = (id: string) => workouts()[id] || TEMPLATES.ab.workouts[id] || TEMPLATES.weekly.workouts[id];
export const workoutName = (id: string, session?: { name?: string }) => session?.name || knownWorkout(id)?.name || id;
export const sessionSlots = (s: { workout: string; slots?: Slot[] }) => s.slots || TEMPLATES.weekly.workouts[s.workout]?.slots || TEMPLATES.ab.workouts[s.workout]?.slots || null;

export function setTemplate(id: string) {
  if (!Object.hasOwn(TEMPLATES, id)) return;
  state.settings.template = id;
  if (state.customPlan) stamp('plan', 'custom', false);
  state.customPlan = null;
  save();
}

export function applyPlan(p: Plan) {
  state.customPlan = { ...p, created: Date.now() };
  stamp('plan', 'custom', true);
  if (p.mode === 'rotation' && p.perWeek) state.settings.perWeek = p.perWeek;
  save();
}

export function resetPlan() {
  state.customPlan = null;
  stamp('plan', 'custom', false);
  save();
}

// ---------- profile (the long-term goal from the intro)

export function saveProfile(p: Record<string, unknown>) {
  state.profile = { ...(state.profile || {}), ...p, onboarded: true, updated: Date.now() };
  if (typeof p.name === 'string') state.settings.name = p.name.slice(0, 24);
  save();
}

// ---------- schedule

// The next session in the rotation (A, B, C, A...). Only a session done in its turn moves the rotation
// on; a session done out of turn (a football swap, or picking another one) leaves the owed one next.
export function nextWorkout() {
  const order = workoutOrder();
  let pointer = 0;
  for (const s of state.sessions) {
    if (s.workout === order[pointer]) pointer = (pointer + 1) % order.length;
  }
  return order[pointer];
}

export function isRestDay(k: string) {
  if (planMode() === 'rotation') return state.rests.includes(k);
  const w = week()![weekdayIdx(k)];
  return !w || w === 'rest' || !workouts()[w];
}

// What the plan asks for on a day: 'rest' or a workout id. On a rotation plan every non-rest day
// asks for the next session in order.
export function plannedFor(k: string): string {
  if (isRestDay(k)) return 'rest';
  return planMode() === 'rotation' ? nextWorkout() : week()![weekdayIdx(k)];
}

export const isFootball = (k: string) => state.football.includes(k);

// Football on a leg day means doing the next non-leg session instead. On a rotation the leg session
// stays next for another day. Leg exercises inside other sessions are dropped (see startWorkout).
export function suggestedFor(k: string): string {
  const planned = plannedFor(k);
  if (planned === 'rest' || !isFootball(k) || !workouts()[planned].legs) return planned;
  if (planMode() === 'rotation') {
    const order = workoutOrder();
    const at = order.indexOf(planned);
    for (let n = 1; n < order.length; n++) {
      const w = order[(at + n) % order.length];
      if (!workouts()[w].legs) return w;
    }
    return planned;
  }
  for (let i = 1; i < 7; i++) {
    const w = plannedFor(addDays(k, i));
    if (w !== 'rest' && !workouts()[w].legs) return w;
  }
  return planned;
}

export function toggleFootball(k: string) {
  const on = !isFootball(k);
  state.football = on ? [...state.football, k].sort() : state.football.filter((d) => d !== k);
  stamp('football', k, on);
  save();
}

// Rest days on a rotation plan: 7 minus the weekly target, per Monday-to-Sunday week.
export const restAllowance = () => Math.max(0, 7 - perWeek());
export const restsUsed = (k = todayKey()) => state.rests.filter((d) => mondayOf(d) === mondayOf(k)).length;
export const restsLeft = (k = todayKey()) => restAllowance() - restsUsed(k);

export function toggleRest(k = todayKey()) {
  if (state.rests.includes(k)) {
    state.rests = state.rests.filter((d) => d !== k);
    stamp('rests', k, false);
  } else if (restsLeft(k) > 0) {
    state.rests = [...state.rests, k].sort();
    stamp('rests', k, true);
  } else return false;
  save();
  return true;
}

// Indexed by date and rebuilt only when the list changes, so streaks over years of history stay quick.
let byDate: { list: Session[]; len: number; map: Map<string, Session[]> } | null = null;
export function sessionsOn(k: string): Session[] {
  if (!byDate || byDate.list !== state.sessions || byDate.len !== state.sessions.length) {
    const map = new Map<string, Session[]>();
    for (const s of state.sessions) map.set(s.date, [...(map.get(s.date) || []), s]);
    byDate = { list: state.sessions, len: state.sessions.length, map };
  }
  return byDate.map.get(k) || [];
}

// The first day of training (workouts or football).
export function trainingStart(): string | null {
  const days = [...state.sessions.map((s) => s.date), ...state.football].sort();
  return days[0] || null;
}

// The first day anything counted: training, or the first quest (from the day it was added).
export function firstDay(): string | null {
  const days = [trainingStart(), ...activeQuests().map(({ quest }) => quest.created)].filter((d): d is string => !!d).sort();
  return days[0] || null;
}

export function programWeek(k = todayKey()) {
  const start = trainingStart();
  if (!start) return 1;
  return Math.floor(daysBetween(start, k) / 7) + 1;
}

// ---------- easy weeks

export function easyWeekStart(k = todayKey()) {
  return (
    state.easyWeeks.find((s) => {
      const d = daysBetween(s, k);
      return d >= 0 && d < 7;
    }) || null
  );
}
export const isEasy = (k = todayKey()) => !!easyWeekStart(k);

export function startEasyWeek() {
  const k = todayKey();
  if (!isEasy(k)) {
    state.easyWeeks = [...state.easyWeeks, k].sort();
    stamp('easyWeeks', k, true);
  }
  save();
}
// Ending early keeps the easy week on record (so the next one isn't due straight away) by moving
// its start back so the 7 days are over. Any overlapping ones (two devices both started one) end too.
export function endEasyWeek() {
  const k = todayKey();
  const ended = addDays(k, -7);
  for (const s of state.easyWeeks.filter((d) => daysBetween(d, k) >= 0 && daysBetween(d, k) < 7)) {
    state.easyWeeks = state.easyWeeks.filter((d) => d !== s);
    stamp('easyWeeks', s, false);
  }
  if (!state.easyWeeks.includes(ended)) {
    state.easyWeeks = [...state.easyWeeks, ended].sort();
    stamp('easyWeeks', ended, true);
  }
  save();
}

export function snoozeEasyWeek(days = 7) {
  state.easySnooze = addDays(todayKey(), days);
  save();
}

// Weeks trained since the last easy week (or since starting).
export function weeksSinceEasy(k = todayKey()) {
  const past = state.easyWeeks.filter((s) => s <= k).sort();
  const from = past.length ? addDays(past[past.length - 1], 7) : trainingStart();
  if (!from) return 0;
  return Math.max(0, Math.floor(daysBetween(from, k) / 7));
}

export function easyWeekDue(k = todayKey()) {
  if (isEasy(k)) return false;
  if (state.easySnooze && k < state.easySnooze) return false;
  return weeksSinceEasy(k) >= 6;
}

// ---------- consistency

// Training is asked of a day when the workout plan is on and training had begun by then, so
// turning the plan on later doesn't undo the days before it.
function trainingDue(k: string) {
  const t = workoutsOn() ? trainingStart() : null;
  return !!t && k >= t;
}

// Training counts for a day if you trained, played football, or it was a rest day (or if no
// training was asked of that day).
export function trainingCovered(k: string) {
  return !trainingDue(k) || sessionsOn(k).length > 0 || isFootball(k) || isRestDay(k);
}

// Every weekly quest of that week reached its target.
function weeklyMet(k: string) {
  const weekly = activeQuests().filter(({ quest }) => quest.schedule.kind === 'weekly' && quest.created <= k && (!quest.archived || k < quest.archived));
  return weekly.length > 0 && weekly.every(({ quest }) => quest.schedule.kind === 'weekly' && weekCount(quest.id, k) >= quest.schedule.times);
}

// A day "counts" toward the streak when everything asked of it was done: the training (with the
// workout plan) and every quest due that day. A day that asked for nothing (no plan, only weekly
// quests) counts if something was done on it, or if that week's weekly targets were all met.
export function covered(k: string) {
  const due = activeQuests().filter(({ quest }) => G.dueOn(quest, k));
  if (!trainingCovered(k) || !due.every(({ quest }) => G.isDone(state.checks, k, quest.id))) return false;
  return trainingDue(k) || due.length > 0 || active(k) || weeklyMet(k);
}

// Did anything happen on this day (a workout, football or a ticked quest)?
export const active = (k: string) => sessionsOn(k).length > 0 || isFootball(k) || Object.values(state.checks[k] || {}).some((c) => c.done);

export function currentStreak() {
  const start = firstDay();
  if (!start) return 0;
  let k = todayKey();
  if (!covered(k)) k = addDays(k, -1); // today isn't over yet
  let n = 0;
  while (k >= start && covered(k)) {
    n++;
    k = addDays(k, -1);
  }
  return n;
}

export function bestStreak() {
  const start = firstDay();
  if (!start) return 0;
  const end = todayKey();
  let best = 0;
  let run = 0;
  for (let k = start; k <= end; k = addDays(k, 1)) {
    if (covered(k)) best = Math.max(best, ++run);
    else if (k !== end) run = 0;
  }
  return best;
}

// Share of what was due in the last 28 days (or since starting) that got done: training
// sessions against the plan, and quests against their schedules. Today only counts once done.
export function consistency(k = todayKey()) {
  const start = firstDay();
  if (!start) return null;
  let from = addDays(k, -27);
  if (from < start) from = start;
  let due = 0;
  let done = 0;
  const tStart = trainingStart();
  if (workoutsOn() && tStart) {
    const tFrom = from < tStart ? tStart : from;
    if (planMode() === 'rotation') {
      let days = 0;
      let trainedDays = 0;
      for (let d = tFrom; d <= k; d = addDays(d, 1)) {
        const trained = sessionsOn(d).length > 0 || isFootball(d);
        if (d === k && !trained) continue; // today isn't over yet
        days++;
        if (trained) trainedDays++;
      }
      const expected = (perWeek() * days) / 7;
      due += expected;
      done += Math.min(expected, trainedDays);
    } else {
      for (let d = tFrom; d <= k; d = addDays(d, 1)) {
        if (isRestDay(d)) continue;
        const trained = sessionsOn(d).length > 0 || isFootball(d);
        if (d === k && !trained) continue;
        due++;
        if (trained) done++;
      }
    }
  }
  for (const { quest } of activeQuests()) {
    if (quest.schedule.kind === 'weekly') {
      // Whole weeks count against the target; this week only counts what's done so far.
      for (let mon = mondayOf(from); mon <= k; mon = addDays(mon, 7)) {
        const n = weekCount(quest.id, mon);
        const thisWeek = addDays(mon, 6) >= k;
        if (mon < quest.created && !thisWeek) continue;
        const target = quest.schedule.times;
        due += thisWeek ? Math.min(n, target) : target;
        done += Math.min(n, target);
      }
      continue;
    }
    for (let d = from; d <= k; d = addDays(d, 1)) {
      if (!G.dueOn(quest, d)) continue;
      const ok = G.isDone(state.checks, d, quest.id);
      if (d === k && !ok) continue;
      due++;
      if (ok) done++;
    }
  }
  return due > 0 ? Math.min(100, Math.round((done / due) * 100)) : null;
}

export function weekSummary(k = todayKey()) {
  const mon = mondayOf(k);
  const days = [];
  let done = 0;
  // A rotation's target counts sessions (two in a day are two); a weekly plan's counts days.
  const rotation = planMode() === 'rotation';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const n = sessionsOn(d).length;
    const trained = n > 0;
    done += rotation ? n : trained ? 1 : 0;
    days.push({
      key: d,
      planned: planMode() === 'week' ? plannedFor(d) : null,
      rest: isRestDay(d),
      trained,
      sessions: sessionsOn(d),
      football: isFootball(d),
    });
  }
  return { days, done, target: perWeek() };
}

// ---------- exercise history

const doneSets = (item: Item) => item.sets.filter((s) => s.done);
export const itemTotal = (item: Item) => doneSets(item).reduce((t, s) => t + (Number(s.r) || 0), 0);

// Most recent logged entry for an exercise, preferring the same workout
// (targets differ between days). Returns { session, item } or null.
export function lastEntry(exId: string, workoutId: string, { skipEasy = false } = {}) {
  let fallback: { session: Session; item: Item } | null = null;
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const s = state.sessions[i];
    if (skipEasy && s.easy) continue;
    const item = s.items.find((it) => it.ex === exId && doneSets(it).length);
    if (!item) continue;
    if (s.workout === workoutId) return { session: s, item };
    if (!fallback) fallback = { session: s, item };
  }
  return fallback;
}

// Did this entry hit the top of the range on every prescribed set?
export function hitTop(item: Item | null | undefined, slot: Slot) {
  if (!item || slot.amrap) return false;
  const sets = doneSets(item);
  return sets.length >= slot.sets && sets.every((s) => Number(s.r) >= (slot.max ?? Infinity));
}

export function levelUpDue(slot: Slot, workoutId: string) {
  if (slot.amrap) return false;
  const last = lastEntry(slot.ex, workoutId, { skipEasy: true });
  return !!last && last.session.workout === workoutId && hitTop(last.item, slot);
}

// All entries for one exercise, oldest first.
export function exerciseHistory(exId: string) {
  const out: { session: Session; item: Item }[] = [];
  for (const s of state.sessions) {
    for (const item of s.items) {
      if (item.ex === exId && doneSets(item).length) out.push({ session: s, item });
    }
  }
  return out;
}

export const exercisesWithData = () => Object.keys(EXERCISES).filter((id) => state.sessions.some((s) => s.items.some((it) => it.ex === id && doneSets(it).length)));

// ---------- player level (XP is always recomputed from the log)

export function sessionXP(s: Session) {
  const sets = s.items.reduce((n, it) => n + doneSets(it).length, 0);
  if (!sets) return 0;
  const slots = sessionSlots(s);
  // Saved targets already hold the sets asked for at the time, so a later bulk/cut switch never
  // changes the XP of old workouts.
  const full = !!slots && slots.every((slot, i) => s.items[i] && doneSets(s.items[i]).length >= (s.easy ? Math.ceil(slot.sets / 2) : slot.sets));
  return sets * 10 + 50 + (full ? 50 : 0); // 10 per set, 50 for showing up, 50 for finishing everything
}

export const FOOTBALL_XP = 30;
export const LOG_XP = 5;
export const BODY_XP = 10;
const loggedDays = () => Object.values(state.logs).filter((l) => l.e || (l.t && l.t.trim())).length;
// Up to two workouts a day earn XP, so a row of one-set workouts can't farm levels. Workouts from
// before 2.0, which had no such limit, keep the XP they earned then.
const XP_SESSIONS_A_DAY = 2;
const XP_CAP_FROM = Date.UTC(2026, 9, 8);
function workoutXP() {
  const perDay = new Map<string, number>();
  let t = 0;
  for (const s of state.sessions) {
    const n = (perDay.get(s.date) || 0) + 1;
    perDay.set(s.date, n);
    if (n <= XP_SESSIONS_A_DAY || (s.finished || 0) < XP_CAP_FROM) t += sessionXP(s);
  }
  return t;
}
export const CHECK_XP = 10;
export const MILESTONE_XP = 100;
export const VALUE_XP = 5;
export const GOAL_XP = 300;

// 10 XP a ticked quest (+5 for reaching its amount), 100 a milestone, 5 a measure logged, 300 a goal done.
function goalXP() {
  const quests = new Map(state.goals.flatMap((g) => g.quests.map((q) => [q.id, q] as const)));
  let t = 0;
  for (const day of Object.values(state.checks)) {
    for (const [qid, c] of Object.entries(day)) {
      if (!c.done) continue;
      const target = quests.get(qid)?.amount?.target;
      t += CHECK_XP + (target && (c.amount ?? 0) >= target ? 5 : 0);
    }
  }
  for (const g of state.goals) {
    t += g.milestones.filter((m) => m.done).length * MILESTONE_XP;
    if (g.status === 'done') t += GOAL_XP;
  }
  for (const days of Object.values(state.values)) t += Object.keys(days).length * VALUE_XP;
  return t;
}

export const totalXP = () => workoutXP() + goalXP() + state.football.length * FOOTBALL_XP + loggedDays() * LOG_XP + state.body.entries.length * BODY_XP;

const RANKS: [number, string, string][] = [
  [50, 'S', 'Shadow Monarch'],
  [35, 'A', 'National Level'],
  [20, 'B', 'Elite Hunter'],
  [10, 'C', 'Relentless'],
  [5, 'D', 'Rising Hunter'],
  [1, 'E', 'Awakened'],
];

export function levelInfo(xp = totalXP()) {
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const base = 100 * (level - 1) ** 2;
  const next = 100 * level ** 2;
  const [, rank, title] = RANKS.find(([min]) => level >= min)!;
  return { xp, level, rank, title, into: xp - base, need: next - base, pct: Math.round(((xp - base) / (next - base)) * 100) };
}

// STR = push & pull reps, AGI = leg reps, VIT = core (holds count 1 per 3 s).
export function stats() {
  const reps = { str: 0, agi: 0, vit: 0 };
  for (const s of state.sessions) {
    for (const it of s.items) {
      const ex = EXERCISES[it.ex];
      if (!ex) continue;
      const v = itemTotal(it);
      reps[ex.stat] += ex.timed ? Math.floor(v / 3) : v;
    }
  }
  // Quests feed the stat of their goal's area: INT for learning, career, money and creative work,
  // SEN for health, mind, people and habits, VIT for fitness.
  const ticks = { int: 0, sen: 0, vit: 0 };
  const statOf = new Map(state.goals.flatMap((g) => g.quests.map((q) => [q.id, G.CATEGORIES[g.category].stat] as const)));
  for (const day of Object.values(state.checks)) for (const [qid, c] of Object.entries(day)) if (c.done && statOf.has(qid)) ticks[statOf.get(qid)!]++;
  return {
    str: 10 + Math.floor(reps.str / 50),
    agi: 10 + Math.floor(reps.agi / 40),
    vit: 10 + Math.floor(reps.vit / 25) + Math.floor(ticks.vit / 5),
    int: 10 + Math.floor(ticks.int / 5),
    sen: 10 + Math.floor(ticks.sen / 5),
  };
}

// ---------- workouts

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Plans can have a cut version: slots with `cut` use that many sets while the phase is Cut.
export const onCut = () => state.body.phase === 'cut';
export const hasCutVersion = () => Object.values(workouts()).some((w) => w.slots.some((slot) => slot.cut != null));

export function targetSets(slot: Slot, easy?: boolean) {
  const n = onCut() && slot.cut != null ? slot.cut : slot.sets;
  return easy ? Math.ceil(n / 2) : n;
}

// Pull-up bar: 'home' (always there), 'nearby' (some sessions at the bar, some at home) or 'none'.
export const needsBar = (workoutId: string) => !!workouts()[workoutId]?.slots.some((slot) => BAR_SWAPS[slot.ex]);
export const noBarByDefault = () => state.settings.bar === 'none';

// The home version of a slot: same sets, a band or floor exercise instead of the bar.
export function swapForBar(slot: Slot): Slot {
  const sw = BAR_SWAPS[slot.ex];
  if (!sw) return slot;
  const { amrap: _amrap, ...rest } = slot;
  return { ...rest, ex: sw.ex, min: sw.min, max: sw.max, note: sw.note, from: slot.ex };
}

// The slots to show for a session: the home versions when there's no bar.
export const viewSlots = (workoutId: string, noBar = noBarByDefault()) => workouts()[workoutId].slots.map((slot) => (noBar ? swapForBar(slot) : slot));

export function startWorkout(workoutId: string, { noBar = noBarByDefault() } = {}) {
  const easy = isEasy();
  const w = workouts()[workoutId];
  if (!w) return;
  // The saved copy records the sets actually asked for, so a later phase change never rewrites history.
  let slots = w.slots.map(({ cut, ...slot }) => ({ ...slot, sets: onCut() && cut != null ? cut : slot.sets })).map((slot) => (noBar ? swapForBar(slot) : slot));
  let skippedLegs = false;
  if (planMode() === 'rotation' && isFootball(todayKey())) {
    const upper = slots.filter((slot) => EXERCISES[slot.ex]?.stat !== 'agi');
    if (upper.length && upper.length < slots.length) {
      slots = upper;
      skippedLegs = true;
    }
  }
  state.active = {
    id: uid(),
    workout: workoutId,
    name: w.name,
    slots,
    skippedLegs,
    atHome: noBar && slots.some((slot) => slot.from),
    date: todayKey(),
    started: Date.now(),
    easy,
    focus: 0,
    timer: null,
    items: slots.map((slot) => {
      const last = lastEntry(slot.ex, workoutId);
      const prev = last ? doneSets(last.item) : [];
      const n = targetSets(slot, easy);
      const fallback = slot.amrap ? (prev[0]?.r ?? 5) : (slot.min ?? 8);
      return {
        ex: slot.ex,
        setup: last?.item.setup || '',
        sets: Array.from({ length: n }, (_, i) => ({ r: prev[i]?.r ?? prev[prev.length - 1]?.r ?? fallback, done: false })),
      };
    }),
  };
  save();
}

const bySessionTime = (x: Session, y: Session) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1);

export function finishWorkout(): Session | null {
  const a = state.active;
  if (!a) return null;
  const session: Session = {
    id: a.id,
    workout: a.workout,
    name: a.name,
    // The targets as asked for, without the setup notes (they're in the plan, and repeating them
    // in every past workout fills up the phone's storage over the years).
    slots: a.slots.map(({ note: _note, ...slot }) => slot),
    date: a.date,
    started: a.started,
    finished: Date.now(),
    easy: a.easy,
    ...(a.atHome ? { atHome: true as const } : {}),
    items: a.items.map((it) => ({ ex: it.ex, setup: it.setup.trim(), sets: it.sets.filter((s) => s.done).map((s) => ({ r: Number(s.r) || 0, done: true })) })),
  };
  state.sessions.push(session);
  state.sessions.sort(bySessionTime);
  state.active = null;
  save();
  return session;
}

export function discardWorkout() {
  state.active = null;
  save();
}

export function deleteSession(id: string) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  stamp('sessions', id, false);
  save();
}

// ---------- daily log

export function setLog(k: string, patch: { e?: number | null; t?: string; ai?: string }) {
  const cur = state.logs[k] || {};
  state.logs[k] = { ...cur, ...patch, at: Date.now() };
  save();
}

export const recentLogs = (n = 10) =>
  Object.entries(state.logs)
    .filter(([, l]) => l.e || (l.t && l.t.trim()))
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, n);

// ---------- body: bulk / cut phase and weigh-ins

export const PHASES: Record<string, { label: string; lo: number; hi: number; text: string }> = {
  bulk: { label: 'Bulk', lo: 0.25, hi: 0.5, text: 'gain about 0.25-0.5% of your bodyweight a week' },
  cut: { label: 'Cut', lo: -0.75, hi: -0.4, text: 'lose about 0.4-0.75% of your bodyweight a week' },
  maintain: { label: 'Maintain', lo: -0.25, hi: 0.25, text: 'stay within about 0.25% a week' },
};

export function setPhase(phase: string | null) {
  const next = phase && Object.hasOwn(PHASES, phase) ? phase : null;
  if (next === state.body.phase) return;
  state.body.phase = next;
  state.body.phaseSince = next ? todayKey() : null;
  save();
}

const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null;
};

export const BODY_RANGES = { weight: [25, 400], waist: [40, 250], shoulders: [60, 250] } as const;

// 'saved', 'empty' (nothing typed) or the name of the first number that's out of range.
export function addBodyEntry({ weight, waist, shoulders }: { weight?: unknown; waist?: unknown; shoulders?: unknown }, k = todayKey()): 'saved' | 'empty' | keyof typeof BODY_RANGES {
  const typed = { weight, waist, shoulders };
  const fresh = {
    weight: num(weight, ...BODY_RANGES.weight),
    waist: num(waist, ...BODY_RANGES.waist),
    shoulders: num(shoulders, ...BODY_RANGES.shoulders),
  };
  for (const f of ['weight', 'waist', 'shoulders'] as const) {
    if (String(typed[f] ?? '').trim() !== '' && fresh[f] == null) return f;
  }
  if (fresh.weight == null && fresh.waist == null && fresh.shoulders == null) return 'empty';
  // A second weigh-in on the same day only overwrites the numbers that were entered.
  const prev: Partial<BodyEntry> = state.body.entries.find((e) => e.date === k) || {};
  const entry: BodyEntry = { date: k, weight: fresh.weight ?? prev.weight ?? null, waist: fresh.waist ?? prev.waist ?? null, shoulders: fresh.shoulders ?? prev.shoulders ?? null, at: Date.now() };
  state.body.entries = state.body.entries.filter((e) => e.date !== k);
  state.body.entries.push(entry);
  state.body.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
  stamp('body', k, true);
  save();
  return 'saved';
}

// Latest numbers, weekly weight trend (least squares over the last 4 weeks) and the V-taper ratio.
export function bodyStats(k = todayKey()) {
  const entries = state.body.entries;
  if (!entries.length) return { due: true } as const;
  const last = entries[entries.length - 1];
  const latest = (field: 'weight' | 'waist' | 'shoulders') => [...entries].reverse().find((e) => e[field] != null) || null;
  const w = latest('weight');
  const recent = entries.filter((e) => e.weight != null && w && daysBetween(e.date, w.date) <= 28);
  let ratePerWeek: number | null = null;
  if (recent.length >= 2 && daysBetween(recent[0].date, recent[recent.length - 1].date) >= 6) {
    const xs = recent.map((e) => daysBetween(recent[0].date, e.date));
    const ys = recent.map((e) => e.weight as number);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const slope = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0) / xs.reduce((t, x) => t + (x - mx) ** 2, 0);
    ratePerWeek = Math.round(slope * 7 * 100) / 100;
  }
  const ratePct = ratePerWeek != null && w?.weight ? Math.round((ratePerWeek / w.weight) * 1000) / 10 : null;
  const both = [...entries].reverse().find((e) => e.waist != null && e.shoulders != null);
  const phase = state.body.phase ? PHASES[state.body.phase] : null;
  // 'slow' and 'fast' are about progress toward the phase's goal: on a cut, dropping weight
  // faster than the range is "fast" even though the number is below it.
  let verdict: 'slow' | 'fast' | 'ok' | null = null;
  if (phase && ratePct != null) {
    const below = ratePct < phase.lo;
    const above = ratePct > phase.hi;
    const cut = state.body.phase === 'cut';
    verdict = below ? (cut ? 'fast' : 'slow') : above ? (cut ? 'slow' : 'fast') : 'ok';
  }
  return {
    last,
    weight: w?.weight ?? null,
    waist: latest('waist')?.waist ?? null,
    shoulders: latest('shoulders')?.shoulders ?? null,
    ratio: both ? Math.round((both.shoulders! / both.waist!) * 100) / 100 : null,
    ratePerWeek,
    ratePct,
    verdict,
    due: daysBetween(last.date, k) >= 7,
  };
}

// ---------- goals

export const goalById = (id: string) => state.goals.find((g) => g.id === id) || null;
export const activeGoals = () => state.goals.filter((g) => g.status === 'active');
export const workoutsOn = () => state.goals.some((g) => g.workouts && g.status === 'active');
export const activeQuests = () => activeGoals().flatMap((goal) => goal.quests.map((quest) => ({ goal, quest })));

// Adds or replaces a goal. Only one goal uses the workout plan at a time.
export function saveGoal(raw: unknown): Goal | null {
  const goal = G.cleanGoal({ ...(raw as object), updated: Date.now() }, todayKey());
  if (!goal) return null;
  const at = state.goals.findIndex((g) => g.id === goal.id);
  if (goal.workouts) {
    state.goals = state.goals.map((g) => {
      if (g.id === goal.id || !g.workouts) return g;
      const { workouts: _w, ...rest } = g;
      return { ...rest, updated: Date.now() };
    });
  }
  if (at >= 0) state.goals[at] = goal;
  else state.goals.push(goal);
  stamp('goals', goal.id, true);
  save();
  return goal;
}

export function deleteGoal(id: string) {
  state.goals = state.goals.filter((g) => g.id !== id);
  stamp('goals', id, false);
  save();
}

export function setGoalStatus(id: string, status: Goal['status']) {
  const g = goalById(id);
  if (g) saveGoal({ ...g, status });
}

// Tick a quest off (or not) for a day. `amount` for quests with one, like 30 min.
export function tick(qid: string, { done, amount }: { done: boolean; amount?: number }, k = todayKey()) {
  const day = (state.checks[k] ||= {});
  const c: G.Check = { done, at: Date.now() };
  if (amount != null && Number.isFinite(amount)) c.amount = Math.max(0, Math.min(1e6, Math.round(amount * 100) / 100));
  day[qid] = c;
  save();
}

// How many times a quest was done in the Monday-to-Sunday week of `k`.
export function weekCount(qid: string, k = todayKey()) {
  const mon = mondayOf(k);
  let n = 0;
  for (let i = 0; i < 7; i++) if (G.isDone(state.checks, addDays(mon, i), qid)) n++;
  return n;
}

// The day's list: due quests, plus weekly ones that still need doing (or were done today).
export function questsFor(k = todayKey()) {
  return activeQuests()
    .map(({ goal, quest }) => {
      const check = state.checks[k]?.[quest.id] || null;
      const week = weekCount(quest.id, k);
      return { goal, quest, check, done: !!check?.done, week };
    })
    .filter(({ quest, done, week }) => G.showOn(quest, k, week, done));
}

// How many times in a row a quest has been done when due (days), or met its weekly target (weeks).
export function questStreak(q: Quest, k = todayKey()) {
  let n = 0;
  if (q.schedule.kind === 'weekly') {
    let mon = mondayOf(k);
    if (weekCount(q.id, mon) < q.schedule.times) mon = addDays(mon, -7); // this week isn't over yet
    while (mon >= mondayOf(q.created) && weekCount(q.id, mon) >= q.schedule.times) {
      n++;
      mon = addDays(mon, -7);
    }
    return n;
  }
  let d = G.isDone(state.checks, k, q.id) || !G.dueOn(q, k) ? k : addDays(k, -1);
  for (let guard = 0; d >= q.created && guard < 3660; guard++, d = addDays(d, -1)) {
    if (!G.dueOn(q, d)) continue;
    if (!G.isDone(state.checks, d, q.id)) break;
    n++;
  }
  return n;
}

export function logValue(mid: string, v: number, k = todayKey()) {
  if (!Number.isFinite(v)) return false;
  (state.values[mid] ||= {})[k] = { v: Math.round(v * 100) / 100, at: Date.now() };
  save();
  return true;
}

export const measureSeries = (mid: string) =>
  Object.entries(state.values[mid] || {})
    .map(([date, e]) => ({ date, v: e.v }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

export function toggleMilestone(goalId: string, mid: string) {
  const g = goalById(goalId);
  if (!g) return;
  saveGoal({ ...g, milestones: g.milestones.map((m) => (m.id === mid ? { ...m, done: m.done ? undefined : todayKey() } : m)) });
}

// ---------- backup

export function exportData() {
  const { active: _active, ...rest } = state;
  return { app: 'physical-improvement-tracker', exported: new Date().toISOString(), ...rest };
}

// Nothing of the Player's own yet: no history and no real goal (an intro that was skipped
// doesn't count). A backup loaded into a device like this is a full restore.
export const isEmpty = (s: State = state) => !s.sessions.length && !Object.keys(s.logs).length && !s.body.entries.length && !s.profile?.goal && !s.goals.length && !Object.keys(s.checks).length;

// Load a backup. On an empty device it's a full restore (plan, settings and profile included);
// otherwise it's merged in, so phone + tablet histories combine and this device keeps its own
// plan and settings. Returns how many new workouts it added.
export function importData(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { sessions?: unknown }).sessions)) throw new Error('This file is not an Arise backup.');
  const data = clean(raw);
  const before = new Set(state.sessions.map((s) => s.id));
  const added = data.sessions.filter((s) => !before.has(s.id)).length;
  if (isEmpty()) {
    // Settings that belong to this device stay as they are.
    const { notify, aiProvider, aiModel, aiBase, aiEngine } = state.settings;
    state = clean({ ...data, settings: { ...data.settings, notify, aiProvider, aiModel, aiBase, aiEngine }, active: state.active, updatedAt: state.updatedAt });
    for (const s of data.sessions) stamp('sessions', s.id, true);
    save();
    return added;
  }
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  for (const s of data.sessions) {
    if (byId.has(s.id)) continue; // the copy on this device wins
    byId.set(s.id, s);
    stamp('sessions', s.id, true);
  }
  state.sessions = [...byId.values()].sort(bySessionTime);
  for (const c of ['football', 'easyWeeks', 'rests'] as const) {
    for (const d of data[c]) if (!state[c].includes(d)) stamp(c, d, true);
    state[c] = [...new Set([...state[c], ...data[c]])].sort();
  }
  for (const [k, l] of Object.entries(data.logs)) {
    if (!state.logs[k] || (l.at || 0) > (state.logs[k].at || 0)) state.logs[k] = l;
  }
  if (!state.profile?.goal && data.profile?.goal) state.profile = data.profile;
  const have = new Set(state.body.entries.map((e) => e.date));
  for (const e of data.body.entries) {
    if (have.has(e.date)) continue;
    const entry = cleanBodyEntry(e);
    if (entry) {
      state.body.entries.push(entry);
      stamp('body', e.date, true);
    }
  }
  state.body.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!state.body.phase && data.body.phase) {
    state.body.phase = data.body.phase;
    state.body.phaseSince = data.body.phaseSince;
  }
  if (!state.customPlan && data.customPlan) state.customPlan = data.customPlan;
  for (const g of data.goals) {
    if (state.goals.some((x) => x.id === g.id)) continue;
    // Not a goal deleted on this device (an old backup makes its fitness goal again on loading).
    if ((state.stamps.goals?.[g.id] ?? 0) < 0) continue;
    // Only one goal uses the workout plan; an old backup's own one isn't needed then.
    const planGoal = state.goals.some((x) => x.workouts);
    if (g.workouts && planGoal && g.id === 'fitness') continue;
    const { workouts: _w, ...rest } = g;
    state.goals.push(planGoal ? rest : g);
    stamp('goals', g.id, true);
  }
  for (const [k, day] of Object.entries(data.checks)) {
    const d = (state.checks[k] ||= {});
    for (const [qid, c] of Object.entries(day)) if (!d[qid] || c.at > d[qid].at) d[qid] = c;
  }
  for (const [mid, days] of Object.entries(data.values)) {
    const m = (state.values[mid] ||= {});
    for (const [k, v] of Object.entries(days)) if (!m[k] || v.at > m[k].at) m[k] = v;
  }
  save();
  return added;
}

export function resetAll() {
  state = blank();
  save();
}
