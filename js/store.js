// Saved data, date helpers and the numbers behind streaks and progress.
// Everything lives in localStorage on this device.

import { WORKOUTS, EXERCISES, WEEK } from './program.js';

const KEY = 'pit-data-v1';

export const DEFAULT_SETTINGS = { restBig: 105, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00' };

function blank() {
  return {
    v: 1,
    settings: { ...DEFAULT_SETTINGS },
    sessions: [], // finished workouts, oldest first
    football: [], // date keys
    easyWeeks: [], // start date keys of easy (deload) weeks
    easySnooze: null, // date key: don't suggest an easy week before this
    logs: {}, // date key -> { e: energy 1-5, t: notes, at: last edit time }
    active: null, // the workout in progress
  };
}

export let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const data = JSON.parse(raw);
    const s = { ...blank(), ...data };
    s.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    return s;
  } catch {
    return blank();
  }
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function replaceState(next) {
  state = next;
  save();
}

// ---------- dates (all local time, keys look like 2026-09-29)

const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => keyOf(new Date());
export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(k, n) {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
}
export const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
export const weekdayIdx = (k) => (parseKey(k).getDay() + 6) % 7; // Monday = 0
export const mondayOf = (k) => addDays(k, -weekdayIdx(k));

// ---------- schedule

export const plannedFor = (k) => WEEK[weekdayIdx(k)];
export const isFootball = (k) => state.football.includes(k);

// Football on a leg day: do the next non-leg session in the week instead.
export function suggestedFor(k) {
  const planned = plannedFor(k);
  if (planned === 'rest' || !isFootball(k) || !WORKOUTS[planned].legs) return planned;
  const idx = weekdayIdx(k);
  for (let i = 1; i < 7; i++) {
    const w = WEEK[(idx + i) % 7];
    if (w !== 'rest' && !WORKOUTS[w].legs) return w;
  }
  return planned;
}

export function toggleFootball(k) {
  if (isFootball(k)) state.football = state.football.filter((d) => d !== k);
  else state.football.push(k);
  save();
}

export const sessionsOn = (k) => state.sessions.filter((s) => s.date === k);

export function firstDay() {
  const days = [...state.sessions.map((s) => s.date), ...state.football].sort();
  return days[0] || null;
}

export function programWeek(k = todayKey()) {
  const start = firstDay();
  if (!start) return 1;
  return Math.floor(daysBetween(start, k) / 7) + 1;
}

// ---------- easy weeks

export function easyWeekStart(k = todayKey()) {
  return state.easyWeeks.find((s) => {
    const d = daysBetween(s, k);
    return d >= 0 && d < 7;
  }) || null;
}
export const isEasy = (k = todayKey()) => !!easyWeekStart(k);

export function startEasyWeek() {
  const k = todayKey();
  if (!isEasy(k)) state.easyWeeks.push(k);
  save();
}
export function endEasyWeek() {
  const s = easyWeekStart();
  if (s) state.easyWeeks = state.easyWeeks.filter((d) => d !== s);
  save();
}

export function snoozeEasyWeek(days = 7) {
  state.easySnooze = addDays(todayKey(), days);
  save();
}

// Weeks trained since the last easy week (or since starting).
export function weeksSinceEasy(k = todayKey()) {
  const past = state.easyWeeks.filter((s) => s <= k).sort();
  const from = past.length ? addDays(past[past.length - 1], 7) : firstDay();
  if (!from) return 0;
  return Math.max(0, Math.floor(daysBetween(from, k) / 7));
}

export function easyWeekDue(k = todayKey()) {
  if (isEasy(k)) return false;
  if (state.easySnooze && k < state.easySnooze) return false;
  return weeksSinceEasy(k) >= 6;
}

// ---------- consistency

// A day "counts" if you trained, played football, or it was the rest day.
export function covered(k) {
  return sessionsOn(k).length > 0 || isFootball(k) || plannedFor(k) === 'rest';
}

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

// Share of training days in the last 28 days (or since starting) that you
// trained or played football.
export function consistency(k = todayKey()) {
  const start = firstDay();
  if (!start) return null;
  let from = addDays(k, -27);
  if (from < start) from = start;
  let planned = 0;
  let done = 0;
  for (let d = from; d <= k; d = addDays(d, 1)) {
    if (plannedFor(d) === 'rest') continue;
    const trained = sessionsOn(d).length > 0 || isFootball(d);
    if (d === k && !trained) continue; // today isn't over yet
    planned++;
    if (trained) done++;
  }
  return planned ? Math.round((done / planned) * 100) : null;
}

export function weekSummary(k = todayKey()) {
  const mon = mondayOf(k);
  const days = [];
  let done = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const trained = sessionsOn(d).length > 0;
    if (trained) done++;
    days.push({ key: d, planned: plannedFor(d), trained, football: isFootball(d) });
  }
  return { days, done, target: WEEK.filter((w) => w !== 'rest').length };
}

// ---------- exercise history

const doneSets = (item) => item.sets.filter((s) => s.done);
export const itemTotal = (item) => doneSets(item).reduce((t, s) => t + (Number(s.r) || 0), 0);

// Most recent logged entry for an exercise, preferring the same workout
// (targets differ between days). Returns { session, item } or null.
export function lastEntry(exId, workoutId, { skipEasy = false } = {}) {
  let fallback = null;
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
export function hitTop(item, slot) {
  if (!item || slot.amrap) return false;
  const sets = doneSets(item);
  return sets.length >= slot.sets && sets.every((s) => Number(s.r) >= slot.max);
}

export function levelUpDue(slot, workoutId) {
  if (slot.amrap) return false;
  const last = lastEntry(slot.ex, workoutId, { skipEasy: true });
  return !!last && last.session.workout === workoutId && hitTop(last.item, slot);
}

// All entries for one exercise, oldest first.
export function exerciseHistory(exId) {
  const out = [];
  for (const s of state.sessions) {
    for (const item of s.items) {
      if (item.ex === exId && doneSets(item).length) out.push({ session: s, item });
    }
  }
  return out;
}

export const exercisesWithData = () =>
  Object.keys(EXERCISES).filter((id) => state.sessions.some((s) => s.items.some((it) => it.ex === id && doneSets(it).length)));

// ---------- player level (XP is always recomputed from the log)

export function sessionXP(s) {
  const sets = s.items.reduce((n, it) => n + doneSets(it).length, 0);
  if (!sets) return 0;
  const full = WORKOUTS[s.workout].slots.every((slot, i) => s.items[i] && doneSets(s.items[i]).length >= targetSets(slot, s.easy));
  return sets * 10 + 50 + (full ? 50 : 0); // 10 per set, 50 for showing up, 50 for finishing everything
}

export const FOOTBALL_XP = 30;
export const LOG_XP = 5;
const loggedDays = () => Object.values(state.logs).filter((l) => l.e || (l.t && l.t.trim())).length;
export const totalXP = () =>
  state.sessions.reduce((t, s) => t + sessionXP(s), 0) + state.football.length * FOOTBALL_XP + loggedDays() * LOG_XP;

const RANKS = [
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
  const [, rank, title] = RANKS.find(([min]) => level >= min);
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
  return {
    str: 10 + Math.floor(reps.str / 50),
    agi: 10 + Math.floor(reps.agi / 40),
    vit: 10 + Math.floor(reps.vit / 25),
  };
}

// ---------- workouts

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function targetSets(slot, easy) {
  return easy ? Math.ceil(slot.sets / 2) : slot.sets;
}

export function startWorkout(workoutId) {
  const easy = isEasy();
  const w = WORKOUTS[workoutId];
  state.active = {
    id: uid(),
    workout: workoutId,
    date: todayKey(),
    started: Date.now(),
    easy,
    focus: 0,
    timer: null,
    items: w.slots.map((slot) => {
      const last = lastEntry(slot.ex, workoutId);
      const prev = last ? doneSets(last.item) : [];
      const n = targetSets(slot, easy);
      const fallback = slot.amrap ? (prev[0]?.r ?? 5) : slot.min;
      return {
        ex: slot.ex,
        setup: last?.item.setup || '',
        sets: Array.from({ length: n }, (_, i) => ({ r: prev[i]?.r ?? prev[prev.length - 1]?.r ?? fallback, done: false })),
      };
    }),
  };
  save();
}

export function finishWorkout() {
  const a = state.active;
  if (!a) return null;
  const session = {
    id: a.id,
    workout: a.workout,
    date: a.date,
    started: a.started,
    finished: Date.now(),
    easy: a.easy,
    items: a.items.map((it) => ({ ex: it.ex, setup: it.setup.trim(), sets: it.sets.filter((s) => s.done).map((s) => ({ r: Number(s.r) || 0, done: true })) })),
  };
  state.sessions.push(session);
  state.sessions.sort((x, y) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1));
  state.active = null;
  save();
  return session;
}

export function discardWorkout() {
  state.active = null;
  save();
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  save();
}

// ---------- daily log

export function setLog(k, patch) {
  const cur = state.logs[k] || {};
  state.logs[k] = { ...cur, ...patch, at: Date.now() };
  save();
}

export const recentLogs = (n = 10) =>
  Object.entries(state.logs)
    .filter(([, l]) => l.e || (l.t && l.t.trim()))
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, n);

// ---------- backup

export function exportData() {
  const { active, ...rest } = state;
  return { app: 'physical-improvement-tracker', exported: new Date().toISOString(), ...rest };
}

// Merge a backup into this device's data (so phone + tablet histories combine).
export function importData(data) {
  if (!data || !Array.isArray(data.sessions)) throw new Error('This file is not a tracker backup.');
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  let added = 0;
  for (const s of data.sessions) {
    if (!s || !s.id || !s.date || !WORKOUTS[s.workout] || !Array.isArray(s.items)) continue;
    if (!byId.has(s.id)) added++;
    byId.set(s.id, s);
  }
  state.sessions = [...byId.values()].sort((x, y) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1));
  state.football = [...new Set([...state.football, ...(data.football || [])])].sort();
  state.easyWeeks = [...new Set([...state.easyWeeks, ...(data.easyWeeks || [])])].sort();
  for (const [k, l] of Object.entries(data.logs || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !l) continue;
    if (!state.logs[k] || (l.at || 0) > (state.logs[k].at || 0)) state.logs[k] = l;
  }
  save();
  return added;
}

export function resetAll() {
  state = blank();
  save();
}
