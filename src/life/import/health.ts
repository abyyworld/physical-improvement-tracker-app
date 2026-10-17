// Apple Health: export.zip from the Health app (apple_health_export/export.xml), which can be
// well over 1 GB. It's read as a stream of tags, never as a whole document:
//
// <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count"
//   startDate="2024-01-02 09:00:00 +0100" endDate="2024-01-02 09:10:00 +0100" value="420"/>
// <Record type="HKCategoryTypeIdentifierSleepAnalysis" … value="HKCategoryValueSleepAnalysisAsleepCore"/>
// <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min"
//   totalDistance="5.01" totalDistanceUnit="km" totalEnergyBurned="300" totalEnergyBurnedUnit="kcal"
//   startDate="…" endDate="…"> (since iOS 16 the totals are in children instead:)
//   <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="300" unit="kcal"/>
// </Workout>
//
// What comes out: each workout; one sleep event per night (the time asleep, from every source
// merged); and one event per day for steps, distance, active energy, resting heart rate, heart
// rate variability, weight and mindful minutes. Never one event per sample.

import type { LifeEvent, LifeKind, LifeTier } from '../types';
import type { TextInput } from './types';
import { XmlTags, attr } from './text-stream';
import { DAY, drain, duration, fixed1, hashId, int, round1 } from './util';

// "2024-01-02 09:00:00 +0100" → its time in ms, the day as written, and the clock there.
interface When {
  ms: number;
  day: string; // the date on the clock where it happened
  offset: number; // minutes east of UTC
}

export function appleTime(v: string | undefined): When | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*(?:([+-])(\d{2}):?(\d{2})|Z)?/);
  if (!m) return null;
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) : 0;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!Number.isFinite(wall)) return null;
  return { ms: wall - offset * 60_000, day: `${m[1]}-${m[2]}-${m[3]}`, offset };
}

// The start of a day on the clock with this offset.
function dayStart(day: string, offset: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offset * 60_000;
}

type How = 'sum' | 'avg' | 'last' | 'time'; // time: how long, from sessions (overlaps once)
interface Daily {
  key: string;
  how: How;
  tier: LifeTier;
  kind: LifeKind;
  unit: (u: string) => [string, number]; // the unit shown, and what to multiply by
  title: (v: number, unit: string) => string;
}

const DISTANCE = (u: string): [string, number] => (u === 'mi' ? ['mi', 1] : u === 'm' ? ['km', 0.001] : u === 'ft' ? ['mi', 1 / 5280] : u === 'yd' ? ['mi', 1 / 1760] : ['km', 1]);
const ENERGY = (u: string): [string, number] => (u === 'kJ' ? ['kcal', 1 / 4.184] : u === 'J' ? ['kcal', 1 / 4184] : ['kcal', 1]);
const MASS = (u: string): [string, number] => (u === 'g' ? ['kg', 0.001] : u === 'st' ? ['lb', 14] : [u || 'kg', 1]);

export const DAILY: Record<string, Daily> = {
  HKQuantityTypeIdentifierStepCount: { key: 'steps', how: 'sum', tier: 2, kind: 'steps', unit: () => ['steps', 1], title: (v) => `${int(v)} steps` },
  HKQuantityTypeIdentifierDistanceWalkingRunning: { key: 'distance', how: 'sum', tier: 2, kind: 'health', unit: DISTANCE, title: (v, u) => `Walked and ran ${fixed1(v)} ${u}` },
  HKQuantityTypeIdentifierActiveEnergyBurned: { key: 'energy', how: 'sum', tier: 2, kind: 'health', unit: ENERGY, title: (v) => `${int(v)} kcal of active energy` },
  HKQuantityTypeIdentifierRestingHeartRate: { key: 'resting-hr', how: 'avg', tier: 3, kind: 'health', unit: () => ['bpm', 1], title: (v) => `Resting heart rate ${int(v)} bpm` },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { key: 'hrv', how: 'avg', tier: 3, kind: 'health', unit: () => ['ms', 1], title: (v) => `Heart rate variability ${int(v)} ms` },
  HKQuantityTypeIdentifierBodyMass: { key: 'weight', how: 'last', tier: 3, kind: 'health', unit: MASS, title: (v, u) => `Weighed ${fixed1(v)} ${u}` },
  HKCategoryTypeIdentifierMindfulSession: { key: 'mindful', how: 'time', tier: 3, kind: 'health', unit: () => ['min', 1], title: (v) => `Mindful for ${duration(v)}` },
};
const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
const CONVERT: Record<string, number> = { 'mi>km': 1.609344, 'km>mi': 1 / 1.609344, 'lb>kg': 0.45359237, 'kg>lb': 1 / 0.45359237 };

interface DayTotal {
  offset: number;
  bySource: Map<string, Float32Array>; // sums: per source, per quarter hour of the day
  n: number; // for averages
  sum: number;
  last: number;
  lastAt: number;
  spans?: [number, number][]; // time: the sessions
}

const QUARTERS = 96;
const quarterOf = (w: When) => Math.floor((((((w.ms + w.offset * 60_000) % DAY) + DAY) % DAY) / (15 * 60_000)));

// Which source counts when two counted the same time, as the Health app does unless told
// otherwise: the Watch, then the iPhone, then apps and other devices.
const rankOf = (source: string, device = '') => (/watch/i.test(source) || /model:\s*watch/i.test(device) ? 2 : /iphone/i.test(source) || /model:\s*iphone/i.test(device) ? 1 : 0);

// A day's sum: each quarter hour from the best source that has it. A Watch and an iPhone that
// counted the same walk count it once, and what the iPhone counted while the Watch was charging
// is still added (taking only the biggest source's total would drop it).
function daySum(t: DayTotal, ranks: Map<string, number>): number {
  const sources = [...t.bySource].map(([s, q]) => [ranks.get(s) ?? 0, q] as const);
  let total = 0;
  for (let i = 0; i < QUARTERS; i++) {
    let rank = -1;
    let v = 0;
    for (const [r, q] of sources) {
      if (!(q[i] > 0)) continue;
      if (r > rank || (r === rank && q[i] > v)) (rank = r), (v = q[i]);
    }
    total += v;
  }
  return total;
}

// "TraditionalStrengthTraining" → "Traditional strength training".
export function workoutName(type: string | undefined): string {
  const t = (type ?? '').replace(/^HKWorkoutActivityType/, '');
  if (!t || t === 'Other') return 'Workout';
  if (t === 'HighIntensityIntervalTraining') return 'HIIT';
  const words = t.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

function minutesOf(v: string | undefined, unit: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return unit === 's' ? n / 60 : unit === 'hr' || unit === 'h' ? n * 60 : n;
}

interface Workout {
  type: string;
  start: When;
  end: When | null;
  minutes: number;
  km: number;
  kcal: number;
  unit: string; // km or mi, as the export says
}

function workoutEvent(w: Workout): LifeEvent {
  const name = workoutName(w.type);
  const parts = [name];
  if (w.minutes > 0) parts.push(duration(w.minutes));
  if (w.km > 0) parts.push(`${fixed1(w.unit === 'mi' ? w.km / 1.609344 : w.km)} ${w.unit}`);
  if (w.kcal > 0) parts.push(`${int(w.kcal)} kcal`);
  const e: LifeEvent = {
    id: `health:${hashId('workout', w.start.ms, w.type)}`,
    source: 'health',
    kind: 'workout',
    at: w.start.ms,
    title: parts.join(' · '),
    tier: 2,
  };
  if (w.end && w.end.ms > w.start.ms) e.end = w.end.ms;
  if (w.minutes > 0) {
    e.value = Math.round(w.minutes);
    e.unit = 'min';
  }
  const meta: Record<string, string | number> = { activity: name };
  if (w.km > 0) meta.km = round1(w.km);
  if (w.kcal > 0) meta.kcal = Math.round(w.kcal);
  e.meta = meta;
  return e;
}

// Total length of time intervals, overlaps counted once.
export function unionMs(spans: [number, number][]): number {
  const s = spans.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of s) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else if (b > curB) curB = b;
  }
  if (curB > curA) total += curB - curA;
  return total;
}

type Span = [number, number, number]; // start, end (ms), offset of the clock (minutes)

const SLEEP_GAP = 3 * 3600_000; // more awake than this between two spans: two different sleeps
const SLEEP_MIN = 20 * 60_000; // shorter sleeps aren't worth an event

// Sleeps from spans asleep (or in bed): spans close together make one sleep.
export function sleepSessions(spans: Span[]): { at: number; end: number; ms: number; offset: number }[] {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: { at: number; end: number; ms: number; offset: number }[] = [];
  let group: Span[] = [];
  let reach = -Infinity; // the latest end so far
  const close = () => {
    if (!group.length) return;
    const ms = unionMs(group.map(([a, b]) => [a, b]));
    if (ms >= SLEEP_MIN) out.push({ at: group[0][0], end: reach, ms, offset: group[group.length - 1][2] });
    group = [];
  };
  for (const sp of s) {
    if (sp[0] - reach > SLEEP_GAP) close();
    group.push(sp);
    reach = Math.max(reach, sp[1]);
  }
  close();
  return out;
}

const TAGS = new Set(['Record', 'Workout', 'WorkoutStatistics']);

export async function* parseAppleHealth(input: TextInput): AsyncGenerator<LifeEvent[]> {
  const xml = new XmlTags(TAGS);
  const out: LifeEvent[] = [];
  const days = new Map<string, Map<string, DayTotal>>(); // type → day → total
  const units = new Map<string, string>(); // type → the unit shown
  const ranks = new Map<string, number>(); // source → rankOf
  const asleep: Span[] = [];
  const inBed: Span[] = [];
  let workout: Workout | null = null;

  const record = (a: string) => {
    const type = attr(a, 'type');
    if (!type) return;
    if (type === SLEEP) {
      const start = appleTime(attr(a, 'startDate'));
      const end = appleTime(attr(a, 'endDate'));
      const v = attr(a, 'value') ?? '';
      if (!start || !end || end.ms <= start.ms || end.ms - start.ms > DAY) return;
      // Older exports say Asleep or InBed (1 or 0); newer ones AsleepCore, AsleepDeep, AsleepREM…
      if (/Asleep/.test(v) || v === '1') asleep.push([start.ms, end.ms, end.offset]);
      else if (/InBed/.test(v) || v === '0') inBed.push([start.ms, end.ms, end.offset]);
      return;
    }
    const d = DAILY[type];
    if (!d) return;
    const start = appleTime(attr(a, 'startDate'));
    if (!start) return;
    let value: number;
    let span: [number, number] | null = null;
    if (type === 'HKCategoryTypeIdentifierMindfulSession') {
      const end = appleTime(attr(a, 'endDate'));
      value = end ? (end.ms - start.ms) / 60_000 : NaN;
      if (end) span = [start.ms, end.ms];
    } else value = Number(attr(a, 'value'));
    if (!Number.isFinite(value) || value < 0) return;
    const [shown, factor] = d.unit(attr(a, 'unit') ?? '');
    value *= factor;
    const want = units.get(type) ?? shown;
    units.set(type, want);
    // A sample in another unit than the first one: change it to that one.
    if (shown !== want) {
      const to = CONVERT[`${shown}>${want}`];
      if (!to) return;
      value *= to;
    }
    let perDay = days.get(type);
    if (!perDay) days.set(type, (perDay = new Map()));
    let t = perDay.get(start.day);
    if (!t) perDay.set(start.day, (t = { offset: start.offset, bySource: new Map(), n: 0, sum: 0, last: 0, lastAt: -Infinity }));
    if (d.how === 'sum') {
      const src = attr(a, 'sourceName') ?? '';
      if (!ranks.has(src)) ranks.set(src, rankOf(src, attr(a, 'device')));
      let q = t.bySource.get(src);
      if (!q) t.bySource.set(src, (q = new Float32Array(QUARTERS)));
      q[quarterOf(start)] += value;
    }
    if (d.how === 'time' && span) (t.spans ??= []).push(span);
    t.n++;
    t.sum += value;
    if (start.ms >= t.lastAt) {
      t.last = value;
      t.lastAt = start.ms;
    }
  };

  const openWorkout = (a: string): Workout | null => {
    const start = appleTime(attr(a, 'startDate'));
    if (!start) return null;
    const end = appleTime(attr(a, 'endDate'));
    let minutes = minutesOf(attr(a, 'duration'), attr(a, 'durationUnit'));
    if (!Number.isFinite(minutes) && end) minutes = (end.ms - start.ms) / 60_000;
    const w: Workout = { type: attr(a, 'workoutActivityType') ?? '', start, end, minutes: Number.isFinite(minutes) ? minutes : 0, km: 0, kcal: 0, unit: 'km' };
    distanceInto(w, attr(a, 'totalDistance'), attr(a, 'totalDistanceUnit'));
    energyInto(w, attr(a, 'totalEnergyBurned'), attr(a, 'totalEnergyBurnedUnit'));
    return w;
  };

  for await (const chunk of input.text) {
    for (const tag of xml.push(chunk)) {
      if (tag.name === 'Record') {
        if (!tag.close) record(tag.attrs);
      } else if (tag.name === 'Workout') {
        if (tag.close) {
          if (workout) out.push(workoutEvent(workout));
          workout = null;
        } else {
          if (workout) out.push(workoutEvent(workout)); // the last one never closed
          workout = openWorkout(tag.attrs);
          if (tag.self && workout) {
            out.push(workoutEvent(workout));
            workout = null;
          }
        }
      } else if (tag.name === 'WorkoutStatistics' && workout && !tag.close) {
        const type = attr(tag.attrs, 'type') ?? '';
        if (/Distance/.test(type) && !workout.km) distanceInto(workout, attr(tag.attrs, 'sum'), attr(tag.attrs, 'unit'));
        else if (type === 'HKQuantityTypeIdentifierActiveEnergyBurned' && !workout.kcal) energyInto(workout, attr(tag.attrs, 'sum'), attr(tag.attrs, 'unit'));
      }
    }
    yield* drain(out);
  }
  if (workout) out.push(workoutEvent(workout));

  // The sleeps, every source merged: time asleep; time in bed only where nothing says asleep.
  const slept = sleepSessions(asleep);
  const bedOnly = sleepSessions(inBed).filter((b) => !slept.some((a) => a.at < b.end && b.at < a.end));
  const sleeps = [...slept.map((x) => ({ ...x, bed: false })), ...bedOnly.map((x) => ({ ...x, bed: true }))];
  // Named by the morning they end; a nap that day too gets a number after the longest sleep.
  const byDay = new Map<string, typeof sleeps>();
  for (const x of sleeps) {
    const day = new Date(x.end + x.offset * 60_000).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), x]);
  }
  for (const [day, list] of byDay) {
    list.sort((a, b) => b.ms - a.ms || a.at - b.at);
    list.forEach((x, i) => {
      out.push({
        id: `health:sleep:${day}${i ? `:${i}` : ''}`,
        source: 'health',
        kind: 'sleep',
        at: x.at,
        end: x.end,
        title: `${x.bed ? 'In bed' : i ? 'Napped' : 'Slept'} ${duration(x.ms / 60_000)}`,
        value: Math.round(x.ms / 60_000),
        unit: 'min',
        tier: 2,
        meta: x.bed ? { day, inBedOnly: true } : { day },
      });
    });
    yield* drain(out);
  }

  // The days.
  for (const [type, perDay] of days) {
    const d = DAILY[type];
    const unit = units.get(type) ?? '';
    for (const [day, t] of perDay) {
      // Sessions from two apps at the same time count once; at different times, both.
      const v = d.how === 'sum' ? daySum(t, ranks) : d.how === 'time' ? unionMs(t.spans ?? []) / 60_000 : d.how === 'avg' ? t.sum / t.n : t.last;
      if (!(v > 0)) continue;
      const at = dayStart(day, t.offset);
      out.push({
        id: `health:${d.key}:${day}`,
        source: 'health',
        kind: d.kind,
        at,
        end: at + DAY,
        title: d.title(v, unit),
        value: d.key === 'steps' || d.key === 'energy' || d.key === 'resting-hr' || d.key === 'hrv' ? Math.round(v) : round1(v),
        unit,
        tier: d.tier,
        meta: { day },
      });
      yield* drain(out);
    }
  }
  yield* drain(out, true);
}

function distanceInto(w: Workout, v: string | undefined, unit: string | undefined) {
  const n = Number(v);
  if (!(n > 0)) return;
  const [shown, f] = DISTANCE(unit ?? 'km');
  const km = shown === 'mi' ? n * f * 1.609344 : n * f;
  w.km = km;
  w.unit = shown;
}

function energyInto(w: Workout, v: string | undefined, unit: string | undefined) {
  const n = Number(v);
  if (!(n > 0)) return;
  w.kcal = n * ENERGY(unit ?? 'kcal')[1];
}

