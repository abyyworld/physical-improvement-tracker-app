// What the iPhone app reads (Apple Health, motion, the calendar, places, Shortcuts automations)
// turned into life events (types.ts). Plain functions with no device access, so they're easy to
// test; sense.ts does the reading.
//
// Every event has a stable id, so reading the same thing twice adds nothing. Things that can
// still change (today's steps, a night that isn't over, an app still open, a visit still going)
// wait until they're settled, since the life log keeps the first version of each id.

import type { LifeEvent, LifeKind, LifeTier } from './types';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : num(v);
  return t !== undefined && Number.isFinite(t) && t > 0 ? t : undefined;
};
const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const whole = (n: number) => Math.round(n).toLocaleString('en-US');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const short = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Meta values must be strings, numbers or booleans: anything missing is left out.
function meta(m: Record<string, string | number | boolean | undefined | null>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

// "25 min", "1 h", "7 h 20 min".
export function duration(minutes: number) {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

// ---------- days (local time on this iPhone)

export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const parts = (key: string) => key.split('-').map(Number) as [number, number, number];
export function dayStart(key: string) {
  const [y, m, d] = parts(key);
  return new Date(y, m - 1, d).getTime();
}
export function nextDay(key: string, n = 1) {
  const [y, m, d] = parts(key);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}
export const isDayKey = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A day's totals are only added once it has been over for 12 hours, so a watch, ring or scale
// that syncs late is counted in. The last day that's settled at `now`:
export const SETTLE_DAY = 12 * HOUR;
export const settledThrough = (now: number) => nextDay(dayKey(now - SETTLE_DAY), -1);

// ---------- Apple Health: daily totals

export interface DayInput {
  steps?: unknown[]; // queryAggregated buckets: { startDate, value }
  distance?: unknown[]; // meters
  energy?: unknown[]; // active kcal
  restingHr?: unknown[];
  weight?: unknown[]; // kg
  hrv?: unknown[]; // readSamples: ms
  mindful?: unknown[]; // readSamples: minutes
}

interface Totals {
  steps?: number;
  meters?: number;
  kcal?: number;
  restingHr?: number;
  hrv?: number;
  kg?: number;
  mindful?: number;
}

// One event per day for movement (tier 2), one for the body (resting heart rate, heart rate
// variability, weight: tier 3) and one for mindful minutes, for each day from `from` to
// `through` that has any.
export function dayEvents(input: DayInput, from: string, through: string): LifeEvent[] {
  const days = new Map<string, Totals>();
  const day = (key: string) => days.get(key) ?? (days.set(key, {}), days.get(key)!);
  const buckets = (rows: unknown[] | undefined, field: keyof Totals) => {
    for (const r of list(rows)) {
      const o = obj(r);
      const at = time(o?.startDate);
      const v = num(o?.value);
      if (at !== undefined && v !== undefined && v >= 0) day(dayKey(at))[field] = v;
    }
  };
  buckets(input.steps, 'steps');
  buckets(input.distance, 'meters');
  buckets(input.energy, 'kcal');
  buckets(input.restingHr, 'restingHr');
  buckets(input.weight, 'kg');
  const hrv = new Map<string, number[]>();
  for (const r of list(input.hrv)) {
    const o = obj(r);
    const at = time(o?.startDate);
    const v = num(o?.value);
    if (at === undefined || v === undefined || v <= 0) continue;
    const k = dayKey(at);
    hrv.set(k, [...(hrv.get(k) ?? []), v]);
  }
  for (const [k, vs] of hrv) day(k).hrv = vs.reduce((a, b) => a + b, 0) / vs.length;
  for (const r of list(input.mindful)) {
    const o = obj(r);
    const at = time(o?.startDate);
    const v = num(o?.value);
    if (at === undefined || v === undefined || v <= 0) continue;
    const t = day(dayKey(at));
    t.mindful = (t.mindful ?? 0) + v;
  }

  const out: LifeEvent[] = [];
  for (const key of [...days.keys()].sort()) {
    if (key < from || key > through) continue;
    const t = days.get(key)!;
    const at = dayStart(key);
    const end = dayStart(nextDay(key));
    const steps = t.steps && t.steps >= 1 ? Math.round(t.steps) : undefined;
    const km = t.meters && t.meters >= 50 ? round(t.meters / 1000, 1) : undefined;
    const kcal = t.kcal && t.kcal >= 1 ? Math.round(t.kcal) : undefined;
    if (steps || km || kcal) {
      const title = [steps && `${whole(steps)} steps`, km && `${km} km on foot`].filter(Boolean).join(', ') || `${whole(kcal!)} active kcal`;
      out.push({
        id: `health:day:${key}`,
        source: 'health',
        kind: 'steps',
        at,
        end,
        title,
        detail: steps || km ? (kcal ? `${whole(kcal)} active kcal` : undefined) : undefined,
        value: steps,
        unit: steps ? 'steps' : undefined,
        tier: 2,
        meta: meta({ steps, km, activeKcal: kcal }),
      });
    }
    const restingHr = t.restingHr ? Math.round(t.restingHr) : undefined;
    const hrvMs = t.hrv ? Math.round(t.hrv) : undefined;
    const kg = t.kg ? round(t.kg, 1) : undefined;
    if (restingHr || hrvMs || kg) {
      const bits = [restingHr && `resting heart rate ${restingHr} bpm`, hrvMs && `HRV ${hrvMs} ms`, kg && `weight ${kg} kg`].filter(Boolean) as string[];
      out.push({ id: `health:body:${key}`, source: 'health', kind: 'health', at, end, title: cap(bits.join(', ')), tier: 3, meta: meta({ restingHr, hrvMs, kg }) });
    }
    const mindful = t.mindful ? Math.round(t.mindful) : 0;
    if (mindful >= 1) {
      out.push({ id: `health:mindful:${key}`, source: 'health', kind: 'health', at, end, title: `${mindful} mindful ${mindful === 1 ? 'minute' : 'minutes'}`, value: mindful, unit: 'min', tier: 2 });
    }
  }
  return out;
}

// ---------- Apple Health: sleep, merged per night

const ASLEEP = new Set(['asleep', 'light', 'deep', 'rem']);
export const SETTLE_SLEEP = 3 * HOUR;
const SLEEP_GAP = HOUR; // waking for less than this is still the same night

interface Span {
  s: number;
  e: number;
}

function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const sp of [...spans].sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && sp.s <= last.e) last.e = Math.max(last.e, sp.e);
    else out.push({ ...sp });
  }
  return out;
}

const clip = (spans: Span[], w: Span) => spans.map((p) => ({ s: Math.max(p.s, w.s), e: Math.min(p.e, w.e) })).filter((p) => p.e > p.s);
const total = (spans: Span[]) => spans.reduce((n, p) => n + p.e - p.s, 0);
// The parts of `spans` that `cover` leaves out.
function minus(spans: Span[], cover: Span[]): Span[] {
  let out = union(spans);
  for (const c of union(cover)) {
    out = out.flatMap((p) => (c.e <= p.s || c.s >= p.e ? [p] : [...(c.s > p.s ? [{ s: p.s, e: c.s }] : []), ...(c.e < p.e ? [{ s: c.e, e: p.e }] : [])]));
  }
  return out;
}

// Health keeps sleep as many short pieces (asleep, core, deep, REM, awake), often from more
// than one device at once. This joins them into one event per night. Like the Health app, it
// trusts one device (the one with the most sleep stages, or else the most sleep) and fills in
// from the others only where that one has nothing, so a night is never counted twice. A
// shorter sleep on the same day is a nap.
export function sleepEvents(samples: unknown[], now: number): LifeEvent[] {
  const pieces = list(samples)
    .map((r) => {
      const o = obj(r);
      const s = time(o?.startDate);
      const e = time(o?.endDate);
      const state = str(o?.sleepState, 20);
      const src = str(o?.sourceId, 200) || str(o?.sourceName, 200) || '?';
      return s !== undefined && e !== undefined && e > s && e - s < DAY ? { s, e, state, src } : null;
    })
    .filter((p): p is NonNullable<typeof p> => !!p);
  const spans: Span[] = [];
  for (const sp of union(pieces.filter((p) => ASLEEP.has(p.state)))) {
    const last = spans[spans.length - 1];
    if (last && sp.s - last.e <= SLEEP_GAP) last.e = sp.e;
    else spans.push({ ...sp });
  }

  const sessions = spans.map((ses) => {
    const bySrc = new Map<string, typeof pieces>();
    for (const p of pieces) if (p.e > ses.s && p.s < ses.e) bySrc.set(p.src, [...(bySrc.get(p.src) ?? []), p]);
    const minutes = (ps: typeof pieces, state: string) => total(clip(ps.filter((p) => p.state === state), ses)) / MIN;
    const staged = (ps: typeof pieces) => minutes(ps, 'light') + minutes(ps, 'deep') + minutes(ps, 'rem');
    const asleep = (ps: typeof pieces) => clip(union(ps.filter((p) => ASLEEP.has(p.state))), ses);
    const [main, ...others] = [...bySrc.values()].sort((a, b) => staged(b) - staged(a) || total(asleep(b)) - total(asleep(a)));
    const covered = clip(main.filter((p) => ASLEEP.has(p.state) || p.state === 'awake'), ses);
    const ms = total(asleep(main)) + total(minus(asleep(others.flat()), covered));
    const stage = (state: string) => (staged(main) ? Math.round(minutes(main, state)) || undefined : undefined);
    return { ...ses, ms, deep: stage('deep'), rem: stage('rem'), core: stage('light'), awake: stage('awake') };
  });

  const byDay = new Map<string, typeof sessions>();
  for (const ses of sessions) {
    if (ses.e > now - SETTLE_SLEEP) continue; // not over yet, or only just
    const k = dayKey(ses.e);
    byDay.set(k, [...(byDay.get(k) ?? []), ses]);
  }
  const out: LifeEvent[] = [];
  for (const [wake, group] of byDay) {
    const longest = group.reduce((a, b) => (b.ms > a.ms ? b : a));
    for (const ses of group) {
      const minutes = ses.ms / MIN;
      const startHour = new Date(ses.s).getHours();
      const night = ses === longest && (minutes >= 180 || startHour >= 18 || startHour < 6);
      if (!night && minutes < 10) continue;
      const { deep, rem, core, awake } = ses;
      const detail = [deep && `deep ${duration(deep)}`, rem && `REM ${duration(rem)}`, core && `core ${duration(core)}`, awake && `awake ${duration(awake)}`].filter(Boolean).join(', ');
      out.push({
        id: night ? `health:sleep:${wake}` : `health:nap:${Math.round(ses.s / MIN)}`,
        source: 'health',
        kind: 'sleep',
        at: ses.s,
        end: ses.e,
        title: `${night ? 'Slept' : 'Napped'} ${duration(minutes)}`,
        detail: detail ? cap(detail) : undefined,
        value: Math.round(minutes),
        unit: 'min',
        tier: 2,
        meta: meta({ deepMin: deep, remMin: rem, coreMin: core, awakeMin: awake }),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- Apple Health: workouts

const WORKOUT_NAMES: Record<string, string> = {
  traditionalStrengthTraining: 'Strength training',
  highIntensityIntervalTraining: 'HIIT',
  other: 'Workout',
};
export const workoutName = (type: string) =>
  WORKOUT_NAMES[type] ?? (cap(type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()) || 'Workout');

export function workoutEvents(rows: unknown[]): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const r of list(rows)) {
    const o = obj(r);
    const at = time(o?.startDate);
    const end = time(o?.endDate);
    if (at === undefined || end === undefined || end < at) continue;
    const type = str(o?.workoutType, 60) || 'other';
    const minutes = (num(o?.duration) ?? (end - at) / 1000) / 60;
    const meters = num(o?.totalDistance);
    const km = meters && meters >= 100 ? round(meters / 1000, 1) : undefined;
    const kcal = num(o?.totalEnergyBurned);
    const uid = str(o?.platformId, 80);
    out.push({
      id: uid ? `health:workout:${uid}` : `health:workout:${type}:${Math.round(at / MIN)}`,
      source: 'health',
      kind: 'workout',
      at,
      end,
      title: `${workoutName(type)}, ${duration(minutes)}${km ? `, ${km} km` : ''}`,
      detail: kcal && kcal >= 1 ? `${whole(kcal)} active kcal` : undefined,
      value: Math.round(minutes),
      unit: 'min',
      tier: 2,
      meta: meta({ type, km, kcal: kcal ? Math.round(kcal) : undefined, app: str(o?.sourceName, 80) }),
    });
  }
  return out;
}

// ---------- Apple Health: State of Mind (iOS 18 and later)

// HealthKit's own numbers for these (HKStateOfMind.Label, .Association, .ValenceClassification).
const FEELINGS = ['', 'very unpleasant', 'unpleasant', 'slightly unpleasant', 'neutral', 'slightly pleasant', 'pleasant', 'very pleasant'];
const LABELS = ['', 'amazed', 'amused', 'angry', 'anxious', 'ashamed', 'brave', 'calm', 'content', 'disappointed', 'discouraged', 'disgusted', 'embarrassed', 'excited', 'frustrated', 'grateful', 'guilty', 'happy', 'hopeless', 'irritated', 'jealous', 'joyful', 'lonely', 'passionate', 'peaceful', 'proud', 'relieved', 'sad', 'scared', 'stressed', 'surprised', 'worried', 'annoyed', 'confident', 'drained', 'hopeful', 'indifferent', 'overwhelmed', 'satisfied'];
const ABOUT = ['', 'community', 'current events', 'dating', 'education', 'family', 'fitness', 'friends', 'health', 'hobbies', 'identity', 'money', 'partner', 'self-care', 'spirituality', 'tasks', 'travel', 'work', 'weather'];
const DAILY_MOOD = 2;

// "a", "a and b", "a, b and c".
const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const named = (nums: unknown, names: string[]) => list(nums).map((n) => (typeof n === 'number' ? names[n] : undefined)).filter((s): s is string => !!s);

export function moodEvents(rows: unknown[]): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const r of list(rows)) {
    const o = obj(r);
    const at = time(o?.at);
    const uid = str(o?.id, 80);
    if (at === undefined || !uid) continue;
    const valence = num(o?.valence);
    const feeling = FEELINGS[num(o?.feeling) ?? 0] ?? '';
    const labels = named(o?.labels, LABELS);
    const about = named(o?.about, ABOUT);
    const daily = num(o?.kind) === DAILY_MOOD;
    const what = labels.length ? and(labels) : feeling || 'a mood';
    out.push({
      id: `health:mood:${uid}`,
      source: 'health',
      kind: 'mood',
      at,
      title: daily ? `Mood of the day: ${what}` : `Felt ${what}`,
      detail: [labels.length && feeling ? cap(feeling) : '', about.length ? `${labels.length && feeling ? 'about' : 'About'} ${and(about)}` : ''].filter(Boolean).join(', ') || undefined,
      value: valence !== undefined ? round(valence, 2) : undefined,
      tier: 3,
      meta: meta({ valence: valence !== undefined ? round(valence, 2) : undefined, feeling, labels: labels.join(', '), about: about.join(', '), daily }),
    });
  }
  return out;
}

// ---------- motion: walks, runs, rides and trips

export interface MotionEntry {
  t: number; // when it started
  k: string; // walk, run, cycle, drive, still, unknown
  c: number; // how sure iOS is: 0 low, 1 medium, 2 high
}

const MOVING: Record<string, { title: (d: string) => string; min: number }> = {
  walk: { title: (d) => `Walked ${d}`, min: 5 },
  run: { title: (d) => `Ran ${d}`, min: 5 },
  cycle: { title: (d) => `Cycled ${d}`, min: 5 },
  drive: { title: (d) => `In a vehicle for ${d}`, min: 5 },
};
const KNOWN = new Set(['walk', 'run', 'cycle', 'drive', 'still', 'unknown']);
const PAUSE = 3 * MIN; // a stop shorter than this (traffic lights, a short wait) doesn't end a trip

export function motionEntries(rows: unknown[]): MotionEntry[] {
  return list(rows)
    .map((r) => {
      const o = obj(r);
      const t = time(o?.t);
      const k = str(o?.k, 10);
      const c = num(o?.c);
      return t !== undefined ? { t, k: KNOWN.has(k) ? k : 'unknown', c: c === undefined ? 0 : Math.max(0, Math.min(2, Math.round(c))) } : null;
    })
    .filter((e): e is MotionEntry => !!e)
    .sort((a, b) => a.t - b.t);
}

// The finished walks, runs, rides and trips between the first entry and `until`. The last one
// may still be going on, so it isn't added yet: `cursor` is where the next read should start, so
// it's read again whole.
export function motionTrips(entries: MotionEntry[], until: number): { events: LifeEvent[]; cursor: number | null } {
  const runs: { k: string; s: number; e: number }[] = [];
  entries.forEach((en, i) => {
    if (en.t >= until) return;
    const e = Math.min(until, entries[i + 1]?.t ?? until);
    // When iOS isn't sure, it's taken as more of the same.
    const k = en.c === 0 ? (runs[runs.length - 1]?.k ?? 'unknown') : en.k;
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.e = e;
    else runs.push({ k, s: en.t, e });
  });
  // A short stop between two stretches of the same thing is part of it.
  const merged: typeof runs = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.k === r.k) {
      prev.e = r.e;
      continue;
    }
    merged.push({ ...r });
    const n = merged.length;
    if (n >= 3) {
      const [a, mid, b] = merged.slice(n - 3);
      if (a.k === b.k && MOVING[a.k] && !MOVING[mid.k] && mid.e - mid.s < PAUSE) {
        a.e = b.e;
        merged.length = n - 2;
      }
    }
  }
  if (!merged.length) return { events: [], cursor: null };
  // The last stretch may go on. So may the one before it, after only a short stop.
  let open = merged.length - 1;
  const tail = merged[open];
  if (open > 0 && !MOVING[tail.k] && tail.e - tail.s < PAUSE) open--;
  const events: LifeEvent[] = [];
  for (const r of merged.slice(0, open)) {
    const kind = MOVING[r.k];
    const minutes = (r.e - r.s) / MIN;
    if (!kind || minutes < kind.min) continue;
    events.push({
      id: `maps:motion:${r.k}:${Math.round(r.s / MIN)}`,
      source: 'maps',
      kind: 'trip',
      at: r.s,
      end: r.e,
      title: kind.title(duration(minutes)),
      value: Math.round(minutes),
      unit: 'min',
      tier: 2,
      meta: { mode: r.k },
    });
  }
  return { events, cursor: merged[open].s };
}

// ---------- calendar

// Calendars that aren't the Player's own life: subscribed ones (holidays) and birthdays
// (EventKit's EKCalendarType numbers).
const NOT_MINE = new Set([3, 4]);

export function calendarEvents(rows: unknown[], now: number): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (const r of list(rows)) {
    const o = obj(r);
    const uid = str(o?.id, 200);
    const at = time(o?.start);
    const end = time(o?.end);
    if (!uid || at === undefined || end === undefined || end < at) continue;
    if (end > now || o?.arise === true || NOT_MINE.has(num(o?.type) ?? -1)) continue; // not over yet, or added by Arise
    const allDay = o?.allDay === true;
    out.push({
      id: `calendar:${uid}:${Math.round(at / MIN)}`,
      source: 'calendar',
      kind: 'event',
      at,
      end,
      title: str(o?.title, 200) || 'Busy',
      detail: str(o?.place, 300) || undefined,
      tier: 2,
      meta: meta({ calendar: str(o?.calendar, 80), allDay: allDay || undefined }),
    });
  }
  return out;
}

// ---------- the inbox: what Shortcuts automations and places left while Arise was closed

export const LOG_KINDS = ['appOpened', 'appClosed', 'arrived', 'left', 'message', 'email', 'focus', 'alarm', 'sleep', 'charging', 'wifi', 'carplay', 'other'] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogItem {
  type: 'log';
  id: string;
  at: number;
  kind: LogKind;
  what: string;
  detail: string;
}
export interface VisitItem {
  type: 'visit';
  id: string;
  arrive?: number;
  depart?: number;
  lat: number;
  lon: number;
}
export type InboxItem = LogItem | VisitItem;

const ID = /^[A-Za-z0-9-]{1,64}$/;

export function cleanItem(raw: unknown): InboxItem | null {
  const o = obj(raw);
  if (!o || typeof o.id !== 'string' || !ID.test(o.id)) return null;
  if (o.type === 'log') {
    const at = time(o.at);
    if (at === undefined) return null;
    const kind = (LOG_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as LogKind) : 'other';
    return { type: 'log', id: o.id, at, kind, what: str(o.what, 2000), detail: str(o.detail, 2000) };
  }
  if (o.type === 'visit') {
    const lat = num(o.lat);
    const lon = num(o.lon);
    const arrive = time(o.arrive);
    const depart = time(o.depart);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (arrive === undefined && depart === undefined) return null;
    if (arrive !== undefined && depart !== undefined && depart < arrive) return null;
    return { type: 'visit', id: o.id, lat, lon, ...(arrive !== undefined ? { arrive } : {}), ...(depart !== undefined ? { depart } : {}) };
  }
  return null;
}

// The inbox file: one JSON object per line. A line that can't be read is skipped.
export function parseInbox(text: string): InboxItem[] {
  const out: InboxItem[] = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = cleanItem(JSON.parse(line));
      if (item) out.push(item);
    } catch {}
  }
  return out;
}

const KINDS: Record<LogKind, { kind: LifeKind; tier: LifeTier; title: (what: string) => string }> = {
  appOpened: { kind: 'app', tier: 2, title: (w) => (w ? `Opened ${w}` : 'Opened an app') },
  appClosed: { kind: 'app', tier: 2, title: (w) => (w ? `Closed ${w}` : 'Closed an app') },
  arrived: { kind: 'place', tier: 3, title: (w) => (w ? `Arrived at ${w}` : 'Arrived somewhere') },
  left: { kind: 'place', tier: 3, title: (w) => (w ? `Left ${w}` : 'Left somewhere') },
  message: { kind: 'message', tier: 3, title: (w) => (w ? `Message: ${w}` : 'Got a message') },
  email: { kind: 'message', tier: 3, title: (w) => (w ? `Email: ${w}` : 'Got an email') },
  focus: { kind: 'other', tier: 2, title: (w) => (w ? `Focus: ${w}` : 'Focus changed') },
  alarm: { kind: 'other', tier: 2, title: (w) => (w ? `Alarm: ${w}` : 'Alarm') },
  sleep: { kind: 'sleep', tier: 2, title: (w) => (w ? `Sleep: ${w}` : 'Sleep') },
  charging: { kind: 'other', tier: 2, title: (w) => (w ? `Charger: ${w}` : 'Charger') },
  wifi: { kind: 'place', tier: 3, title: (w) => (w ? `Wi-Fi: ${w}` : 'Wi-Fi') },
  carplay: { kind: 'trip', tier: 2, title: (w) => (w ? `CarPlay: ${w}` : 'CarPlay') },
  other: { kind: 'note', tier: 3, title: (w) => w || 'Something happened' },
};

function logEvent(it: LogItem): LifeEvent {
  const k = KINDS[it.kind];
  const what = it.what.replace(/\s+/g, ' ');
  // A long one (a whole message) is kept in full in the detail.
  const long = what.length > 120;
  const detail = [long ? it.what : '', it.detail].filter(Boolean).join('\n\n');
  return {
    id: `shortcut:${it.id}`,
    source: 'shortcut',
    kind: k.kind,
    at: it.at,
    title: k.title(short(what)),
    detail: detail || undefined,
    tier: k.tier,
    meta: { via: it.kind },
  };
}

const APP_SESSION = 12 * HOUR; // an app open longer than this without closing: just "Opened"
const appKey = (what: string) => what.trim().toLowerCase();

// Opened, then closed: one event with how long the app was open ("App time").
function appEvent(open: LogItem, close: LogItem): LifeEvent {
  const name = short(open.what.trim() || close.what.trim() || 'an app', 80);
  const minutes = (close.at - open.at) / MIN;
  return {
    id: `shortcut:${open.id}`,
    source: 'shortcut',
    kind: 'app',
    at: open.at,
    end: close.at,
    title: `Used ${name} for ${minutes < 1 ? 'under a minute' : duration(minutes)}`,
    value: round(minutes, 1),
    unit: 'min',
    tier: 2,
    meta: { app: name },
  };
}

// What can go to the life log now, which visits are ready (they still need a place name), and
// what has to wait: an app that's still open, a place the Player hasn't left yet.
export function sortInbox(items: InboxItem[], held: InboxItem[], now: number): { events: LifeEvent[]; visits: VisitItem[]; held: InboxItem[] } {
  const seen = new Set<string>();
  const all = [...held, ...items].filter((it) => !seen.has(it.id) && !!seen.add(it.id));
  const logs = all.filter((it): it is LogItem => it.type === 'log').sort((a, b) => a.at - b.at);
  const places = all.filter((it): it is VisitItem => it.type === 'visit');
  const events: LifeEvent[] = [];
  const wait: InboxItem[] = [];

  const open = new Map<string, LogItem>();
  for (const it of logs) {
    if (it.kind === 'appOpened') {
      const before = open.get(appKey(it.what));
      if (before) events.push(logEvent(before)); // opened twice: the first is just "Opened"
      open.set(appKey(it.what), it);
    } else if (it.kind === 'appClosed') {
      const o = open.get(appKey(it.what));
      if (o && it.at - o.at <= APP_SESSION) {
        events.push(appEvent(o, it));
        open.delete(appKey(it.what));
      } else events.push(logEvent(it));
    } else events.push(logEvent(it));
  }
  for (const o of open.values()) {
    if (now - o.at > APP_SESSION) events.push(logEvent(o));
    else wait.push(o);
  }

  // iOS tells about a visit twice: on arrival (no departure yet), then on leaving (both times).
  const visits: VisitItem[] = [];
  const when = (v: VisitItem) => v.arrive ?? v.depart ?? 0;
  for (const v of places.sort((a, b) => when(a) - when(b))) {
    if (v.arrive === undefined || v.depart !== undefined) {
      visits.push(v);
      continue;
    }
    const left = places.some((o) => o.arrive !== undefined && o.depart !== undefined && Math.abs(o.arrive - v.arrive!) < 2 * MIN);
    if (left) continue; // the full visit replaces it
    const later = places.some((o) => when(o) > v.arrive! + MIN);
    if (later || now - v.arrive > 3 * DAY) visits.push(v);
    else wait.push(v);
  }
  return { events, visits, held: wait };
}

export interface PlaceName {
  name?: string;
  poi?: string;
  street?: string;
  area?: string;
  city?: string;
  country?: string;
}

export function cleanPlace(raw: unknown): PlaceName {
  const o = obj(raw);
  const out: PlaceName = {};
  for (const k of ['name', 'poi', 'street', 'area', 'city', 'country'] as const) {
    const v = str(o?.[k], 120);
    if (v) out[k] = v;
  }
  return out;
}

export function visitEvent(v: VisitItem, place: PlaceName | null): LifeEvent {
  const name = place?.name || place?.poi || '';
  const at = v.arrive ?? v.depart!;
  const end = v.arrive !== undefined ? v.depart : undefined;
  const where = [place?.street && place.street !== name ? place.street : '', place?.area, place?.city].filter((s) => s && s !== name);
  return {
    id: v.arrive !== undefined ? `maps:visit:${Math.round(v.arrive / 1000)}` : `maps:visit:left:${Math.round(v.depart! / 1000)}`,
    source: 'maps',
    kind: 'place',
    at,
    end,
    title: v.arrive === undefined ? `Left ${name || 'a place'}` : `At ${name || 'a place'}`,
    detail: where.join(', ') || undefined,
    value: end !== undefined ? Math.round((end - at) / MIN) : undefined,
    unit: end !== undefined ? 'min' : undefined,
    tier: 3,
    meta: { lat: round(v.lat, 4), lon: round(v.lon, 4) },
  };
}
