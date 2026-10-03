// Saved data, date helpers and the numbers behind streaks and progress.
// Everything lives in localStorage on this device.

import { TEMPLATES, EXERCISES, BAR_SWAPS } from './program.js';

const KEY = 'pit-data-v1';

export const DEFAULT_SETTINGS = { restBig: 120, restSmall: 60, sound: true, vibrate: true, name: '', remindAt: '07:00', aiDaily: true, template: 'ab', perWeek: 5, notify: false, evening: true, eveningAt: '20:30', aiProvider: '', aiModel: '', aiBase: '', bar: 'home' };

const blankAI = () => ({
  daily: {}, // date key -> { message, focus, at }
  chat: [], // coach conversation: [{ role: 'user' | 'assistant', text, at }]
  nudges: null, // { messages: [...], at } personalised reminder lines
  usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, otherIn: 0, otherOut: 0, calls: 0 }, // token counts; the first four are Claude's default model
});

function blank() {
  return {
    v: 1,
    settings: { ...DEFAULT_SETTINGS },
    sessions: [], // finished workouts, oldest first
    football: [], // date keys
    easyWeeks: [], // start date keys of easy (deload) weeks
    easySnooze: null, // date key: don't suggest an easy week before this
    logs: {}, // date key -> { e: energy 1-5, t: notes, ai: reflection, at: last edit time }
    rests: [], // date keys of rest days taken (rotation plans)
    body: { phase: null, phaseSince: null, entries: [] }, // bulk/cut phase and weigh-ins: { date, weight, waist, shoulders }
    profile: null, // long-term goal and background from the intro
    customPlan: null, // { workouts, week, summary, changes, created } when the plan was personalised
    ai: blankAI(),
    active: null, // the workout in progress
  };
}

let fresh = false;
export let state = load();

// True when this device had no saved data at start (the iOS app then checks its backup file).
export const freshStart = () => fresh;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      fresh = true;
      return blank();
    }
    return normalize(JSON.parse(raw));
  } catch {
    return blank();
  }
}

// Fill in anything missing, so data from an older version (or another device) is always safe to use.
function normalize(data) {
  const s = { ...blank(), ...data };
  s.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  s.ai = { ...blankAI(), ...(data.ai || {}) };
  s.ai.usage = { ...blankAI().usage, ...(s.ai.usage || {}) };
  s.body = { ...blank().body, ...(data.body || {}) };
  if (!Array.isArray(s.body.entries)) s.body.entries = [];
  if (!Array.isArray(s.rests)) s.rests = [];
  for (const k of ['sessions', 'football', 'easyWeeks']) if (!Array.isArray(s[k])) s[k] = [];
  if (!s.logs || typeof s.logs !== 'object') s.logs = {};
  return s;
}

const listeners = [];
export const onSave = (fn) => listeners.push(fn);

// Every change is stamped with the time, so account sync can tell which copy is newer.
// `touch: false` saves without counting as a change (used when taking in synced data).
export function save({ touch = true } = {}) {
  if (touch) state.updatedAt = Date.now();
  let ok = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    ok = false;
  }
  for (const fn of listeners) fn();
  return ok;
}

export const snapshot = () => JSON.stringify(state);

// The iOS app keeps a copy of the data in a file. If the phone ever clears the app's web
// storage, this puts the copy back (the page then reloads).
export function restoreSnapshot(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.sessions)) return false;
  localStorage.setItem(KEY, text);
  return true;
}

export function replaceState(next) {
  state = next;
  save();
}

// Take in data from the cloud. `keep` lists fields that stay as they are on this device.
export function adoptState(data, { keep = {} } = {}) {
  state = normalize({ ...data, ...keep });
  save({ touch: false });
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

// ---------- the plan (a template, or the one personalised by the AI coach)
// 'rotation' plans (like A/B/C) are done in order on any day; 'week' plans use fixed weekdays.

export const plan = () => state.customPlan || TEMPLATES[state.settings.template] || TEMPLATES.ab;
export const planMode = () => (plan().mode === 'rotation' ? 'rotation' : 'week');
export const workouts = () => plan().workouts;
export const workoutOrder = () => plan().order || Object.keys(plan().workouts);
export const week = () => plan().week || null;
export const planRules = () => plan().rules || TEMPLATES[planMode() === 'rotation' ? 'ab' : 'weekly'].rules;
export const isCustomPlan = () => !!state.customPlan;

// Training sessions per week: the user's target on a rotation, the plan's training days on a weekly plan.
export function perWeek() {
  if (planMode() === 'week') return week().filter((w) => w !== 'rest' && workouts()[w]).length;
  return Math.min(7, Math.max(3, Math.round(Number(state.settings.perWeek)) || 5));
}

// Names and targets survive plan changes: sessions keep a copy of what was prescribed.
const knownWorkout = (id) => workouts()[id] || TEMPLATES.ab.workouts[id] || TEMPLATES.weekly.workouts[id];
export const workoutName = (id, session) => session?.name || knownWorkout(id)?.name || id;
export const sessionSlots = (s) => s.slots || TEMPLATES.weekly.workouts[s.workout]?.slots || TEMPLATES.ab.workouts[s.workout]?.slots || null;

export function setTemplate(id) {
  if (!TEMPLATES[id]) return;
  state.settings.template = id;
  state.customPlan = null;
  save();
}

export function applyPlan(p) {
  state.customPlan = { ...p, created: Date.now() };
  if (p.mode === 'rotation' && p.perWeek) state.settings.perWeek = p.perWeek;
  save();
}

export function resetPlan() {
  state.customPlan = null;
  save();
}

// ---------- profile (the long-term goal from the intro)

export function saveProfile(p) {
  state.profile = { ...(state.profile || {}), ...p, onboarded: true, updated: Date.now() };
  if (p.name != null) state.settings.name = p.name;
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

export function isRestDay(k) {
  if (planMode() === 'rotation') return state.rests.includes(k);
  const w = week()[weekdayIdx(k)];
  return !w || w === 'rest' || !workouts()[w];
}

// What the plan asks for on a day: 'rest' or a workout id. On a rotation plan every non-rest day
// asks for the next session in order.
export function plannedFor(k) {
  if (isRestDay(k)) return 'rest';
  return planMode() === 'rotation' ? nextWorkout() : week()[weekdayIdx(k)];
}

export const isFootball = (k) => state.football.includes(k);

// Football on a leg day means doing the next non-leg session instead. On a rotation the leg session
// stays next for another day. Leg exercises inside other sessions are dropped (see startWorkout).
export function suggestedFor(k) {
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

export function toggleFootball(k) {
  if (isFootball(k)) state.football = state.football.filter((d) => d !== k);
  else state.football.push(k);
  save();
}

// Rest days on a rotation plan: 7 minus the weekly target, per Monday-to-Sunday week.
export const restAllowance = () => Math.max(0, 7 - perWeek());
export const restsUsed = (k = todayKey()) => state.rests.filter((d) => mondayOf(d) === mondayOf(k)).length;
export const restsLeft = (k = todayKey()) => restAllowance() - restsUsed(k);

export function toggleRest(k = todayKey()) {
  if (state.rests.includes(k)) state.rests = state.rests.filter((d) => d !== k);
  else if (restsLeft(k) > 0) state.rests.push(k);
  else return false;
  save();
  return true;
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

// A day "counts" if you trained, played football, or it was a rest day.
export function covered(k) {
  return sessionsOn(k).length > 0 || isFootball(k) || isRestDay(k);
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
  if (planMode() === 'rotation') {
    // Sessions (or football) against the weekly target.
    let done = 0;
    let days = 0;
    for (let d = from; d <= k; d = addDays(d, 1)) {
      const trained = sessionsOn(d).length > 0 || isFootball(d);
      if (d === k && !trained) continue; // today isn't over yet
      days++;
      if (trained) done++;
    }
    const expected = (perWeek() * days) / 7;
    return expected > 0 ? Math.min(100, Math.round((done / expected) * 100)) : null;
  }
  let planned = 0;
  let done = 0;
  for (let d = from; d <= k; d = addDays(d, 1)) {
    if (isRestDay(d)) continue;
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
  const slots = sessionSlots(s);
  const full = !!slots && slots.every((slot, i) => s.items[i] && doneSets(s.items[i]).length >= targetSets(slot, s.easy));
  return sets * 10 + 50 + (full ? 50 : 0); // 10 per set, 50 for showing up, 50 for finishing everything
}

export const FOOTBALL_XP = 30;
export const LOG_XP = 5;
export const BODY_XP = 10;
const loggedDays = () => Object.values(state.logs).filter((l) => l.e || (l.t && l.t.trim())).length;
export const totalXP = () =>
  state.sessions.reduce((t, s) => t + sessionXP(s), 0) + state.football.length * FOOTBALL_XP + loggedDays() * LOG_XP + state.body.entries.length * BODY_XP;

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

// Plans can have a cut version: slots with `cut` use that many sets while the phase is Cut.
export const onCut = () => state.body.phase === 'cut';
export const hasCutVersion = () => Object.values(workouts()).some((w) => w.slots.some((slot) => slot.cut != null));

export function targetSets(slot, easy) {
  const n = onCut() && slot.cut != null ? slot.cut : slot.sets;
  return easy ? Math.ceil(n / 2) : n;
}

// Pull-up bar: 'home' (always there), 'nearby' (some sessions at the bar, some at home) or 'none'.
export const needsBar = (workoutId) => !!workouts()[workoutId]?.slots.some((slot) => BAR_SWAPS[slot.ex]);
export const noBarByDefault = () => state.settings.bar === 'none';

// The home version of a slot: same sets, a band or floor exercise instead of the bar.
export function swapForBar(slot) {
  const sw = BAR_SWAPS[slot.ex];
  if (!sw) return slot;
  const { amrap, ...rest } = slot;
  return { ...rest, ex: sw.ex, min: sw.min, max: sw.max, note: sw.note, from: slot.ex };
}

// The slots to show for a session: the home versions when there's no bar.
export const viewSlots = (workoutId, noBar = noBarByDefault()) => workouts()[workoutId].slots.map((slot) => (noBar ? swapForBar(slot) : slot));

export function startWorkout(workoutId, { noBar = noBarByDefault() } = {}) {
  const easy = isEasy();
  const w = workouts()[workoutId];
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
    name: a.name,
    slots: a.slots,
    date: a.date,
    started: a.started,
    finished: Date.now(),
    easy: a.easy,
    ...(a.atHome ? { atHome: true } : {}),
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

// ---------- body: bulk / cut phase and weigh-ins

export const PHASES = {
  bulk: { label: 'Bulk', lo: 0.25, hi: 0.5, text: 'gain about 0.25-0.5% of your bodyweight a week' },
  cut: { label: 'Cut', lo: -0.75, hi: -0.4, text: 'lose about 0.4-0.75% of your bodyweight a week' },
  maintain: { label: 'Maintain', lo: -0.25, hi: 0.25, text: 'stay within about 0.25% a week' },
};

export function setPhase(phase) {
  state.body.phase = PHASES[phase] ? phase : null;
  state.body.phaseSince = state.body.phase ? todayKey() : null;
  save();
}

const num = (v, lo, hi) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 10) / 10 : null;
};

export function addBodyEntry({ weight, waist, shoulders }, k = todayKey()) {
  const fresh = { weight: num(weight, 25, 400), waist: num(waist, 40, 250), shoulders: num(shoulders, 60, 250) };
  if (fresh.weight == null && fresh.waist == null && fresh.shoulders == null) return false;
  // A second weigh-in on the same day only overwrites the numbers that were entered.
  const prev = state.body.entries.find((e) => e.date === k) || {};
  const entry = { date: k, weight: fresh.weight ?? prev.weight ?? null, waist: fresh.waist ?? prev.waist ?? null, shoulders: fresh.shoulders ?? prev.shoulders ?? null };
  state.body.entries = state.body.entries.filter((e) => e.date !== k);
  state.body.entries.push(entry);
  state.body.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
  save();
  return true;
}

// Latest numbers, weekly weight trend (least squares over the last 4 weeks) and the V-taper ratio.
export function bodyStats(k = todayKey()) {
  const entries = state.body.entries;
  if (!entries.length) return { due: true };
  const last = entries[entries.length - 1];
  const latest = (field) => [...entries].reverse().find((e) => e[field] != null) || null;
  const w = latest('weight');
  const recent = entries.filter((e) => e.weight != null && w && daysBetween(e.date, w.date) <= 28);
  let ratePerWeek = null;
  if (recent.length >= 2 && daysBetween(recent[0].date, recent[recent.length - 1].date) >= 6) {
    const xs = recent.map((e) => daysBetween(recent[0].date, e.date));
    const ys = recent.map((e) => e.weight);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const slope = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0) / xs.reduce((t, x) => t + (x - mx) ** 2, 0);
    ratePerWeek = Math.round(slope * 7 * 100) / 100;
  }
  const ratePct = ratePerWeek != null && w ? Math.round((ratePerWeek / w.weight) * 1000) / 10 : null;
  const both = [...entries].reverse().find((e) => e.waist != null && e.shoulders != null);
  const phase = PHASES[state.body.phase];
  let verdict = null;
  if (phase && ratePct != null) verdict = ratePct < phase.lo ? 'slow' : ratePct > phase.hi ? 'fast' : 'ok';
  return {
    last,
    weight: w?.weight ?? null,
    waist: latest('waist')?.waist ?? null,
    shoulders: latest('shoulders')?.shoulders ?? null,
    ratio: both ? Math.round((both.shoulders / both.waist) * 100) / 100 : null,
    ratePerWeek,
    ratePct,
    verdict,
    due: daysBetween(last.date, k) >= 7,
  };
}

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
    if (!s || !s.id || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || typeof s.workout !== 'string' || !Array.isArray(s.items)) continue;
    if (!s.items.every((it) => it && EXERCISES[it.ex] && Array.isArray(it.sets))) continue;
    if (!byId.has(s.id)) added++;
    byId.set(s.id, s);
  }
  state.sessions = [...byId.values()].sort((x, y) => (x.date === y.date ? x.started - y.started : x.date < y.date ? -1 : 1));
  state.football = [...new Set([...state.football, ...(Array.isArray(data.football) ? data.football : []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))])].sort();
  state.easyWeeks = [...new Set([...state.easyWeeks, ...(Array.isArray(data.easyWeeks) ? data.easyWeeks : []).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))])].sort();
  for (const [k, l] of Object.entries(data.logs || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !l) continue;
    if (!state.logs[k] || (l.at || 0) > (state.logs[k].at || 0)) state.logs[k] = l;
  }
  if (!state.profile && data.profile && typeof data.profile === 'object') state.profile = data.profile;
  const isKey = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  state.rests = [...new Set([...state.rests, ...(Array.isArray(data.rests) ? data.rests.filter(isKey) : [])])].sort();
  if (data.body && Array.isArray(data.body.entries)) {
    const have = new Set(state.body.entries.map((e) => e.date));
    for (const e of data.body.entries) {
      if (e && isKey(e.date) && !have.has(e.date)) state.body.entries.push({ date: e.date, weight: num(e.weight, 25, 400), waist: num(e.waist, 40, 250), shoulders: num(e.shoulders, 60, 250) });
    }
    state.body.entries.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!state.body.phase && PHASES[data.body.phase]) state.body.phase = data.body.phase;
  }
  save();
  return added;
}

export function resetAll() {
  state = blank();
  save();
}
