// The Player's days as rows of numbers, for the patterns on the You tab (lib/patterns.ts): their
// own check-in from Arise, and what the life log holds (sleep, steps, workouts, calls and
// messages, app use, the calendar). Each field keeps the tier of what it came from, so a pattern
// made from it reaches only an AI that may read that.
//
// Arise's own events in the log are left out where they would count something twice: the check-in
// (already in logs), questions to the coach, goals and milestones, and workouts (from sessions).
// Emails don't count as being in touch with someone. Without a life log, only Arise's own fields
// are filled.

import * as S from '../store';
import * as G from '../lib/goals';
import type { DayRow } from '../lib/patterns';
import type { State } from '../lib/validate';
import * as L from './log';
import { hasLifeStore } from './store-port';
import { addDays, dayEnd, dayKey, dayStart } from './dates';
import type { LifeEvent, LifeKind, LifeTier } from './types';

const KINDS: LifeKind[] = ['sleep', 'steps', 'workout', 'app', 'call', 'message', 'mood', 'event'];
const HOUR = 3600000;

// How long it lasted: the minutes the source recorded, else from its start to its end (as diary.ts).
const minutesOf = (e: LifeEvent) => (typeof e.value === 'number' && e.value > 0 && /^min/i.test(e.unit || '') ? e.value : e.end && e.end > e.at ? (e.end - e.at) / 60000 : 0);
const maxTier = (xs: readonly LifeEvent[], floor: LifeTier = 1) => xs.reduce<LifeTier>((t, e) => (e.tier > t ? e.tier : t), floor);
const clamp = (n: number) => Math.min(5, Math.max(1, n));
const rating = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

// A call that went through: not missed, and not one they made that nobody answered (no length).
export const wentThrough = (e: LifeEvent) => e.kind !== 'call' || (e.meta?.missed !== true && !(e.meta?.direction === 'out' && !(minutesOf(e) > 0)));
// A step count for the whole day (Health's day total, read live or from its export), not a
// count for a stretch of it.
const dayTotal = (e: LifeEvent) => (!!e.end && e.end - e.at >= 20 * HOUR) || typeof e.meta?.day === 'string';

// A mood from 1 to 5 out of an event: one added in "Your days" (mood 1-5), or Apple's State of
// Mind (a valence from -1 to 1).
function moodOf(e: LifeEvent): number | null {
  if (e.unit === 'mood (1-5)') return typeof e.value === 'number' ? rating(Math.round(e.value)) : null;
  if (e.source !== 'health') return null;
  const v = typeof e.meta?.valence === 'number' ? e.meta.valence : e.value;
  return typeof v === 'number' && v >= -1 && v <= 1 ? clamp(Math.round(2 * v + 3)) : null;
}

// Rows for the days from `fromKey` to `toKey` (both included), oldest first.
export async function dayRows(fromKey: string, toKey: string): Promise<DayRow[]> {
  let events: LifeEvent[] = [];
  if (hasLifeStore() && L.hasLifeDB()) {
    try {
      // From the evening before: the first night's sleep started then.
      events = await L.eventsBetween(dayStart(fromKey) - 12 * HOUR, dayEnd(toKey), { kinds: KINDS, limit: 50000 });
    } catch {
      events = [];
    }
  }
  return rowsFrom(events, fromKey, toKey, S.state);
}

export function rowsFrom(events: readonly LifeEvent[], fromKey: string, toKey: string, st: Pick<State, 'logs' | 'sessions' | 'goals' | 'checks'> & Partial<Pick<State, 'football'>>): DayRow[] {
  const byDay = new Map<string, LifeEvent[]>();
  for (const e of events) {
    const k = dayKey(e.at);
    const list = byDay.get(k);
    if (list) list.push(e);
    else byDay.set(k, [e]);
  }
  const ofKind = (k: string, kind: LifeKind) => (byDay.get(k) || []).filter((e) => e.kind === kind);
  const own = (e: LifeEvent) => e.source === 'arise';
  // In touch with someone: calls that went through and messages, from a source that has them (not
  // the coach, not email, whether from a linked account, Mail on the Mac or a Shortcut).
  const talk = events.filter((e) => (e.kind === 'call' || e.kind === 'message') && !own(e) && e.source !== 'email' && e.meta?.channel !== 'email' && e.meta?.via !== 'email');
  const talked = new Set(talk.filter(wentThrough).map((e) => dayKey(e.at)));
  const sleeps = events.filter((e) => e.kind === 'sleep' && e.end && !/^napped/i.test(e.title) && minutesOf(e) >= 180);
  // The calendar: timed events (all-day ones, like a holiday, aren't time spent).
  const cal = events.filter((e) => e.kind === 'event' && !own(e));
  const timed = cal.filter((e) => e.meta?.allDay !== true && e.meta?.dateOnly !== true && e.end && e.end > e.at && e.end - e.at < 20 * HOUR);
  const calTier = maxTier(cal, 2);
  const quests = st.goals.filter((g) => g.status === 'active').flatMap((g) => g.quests.filter((q) => q.schedule.kind !== 'weekly'));
  // Arise's workouts, and football (a match or training on that day).
  const sessions = new Set([...st.sessions.map((x) => x.date), ...(st.football || [])]);

  const out: DayRow[] = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
    const l = st.logs[k];
    const row: DayRow = { day: k, tier: {} };
    const tier = row.tier!;
    const e = rating(l?.e);
    const s = rating(l?.s);
    if (e) row.e = e;
    if (s) row.s = s;

    // Mood: their check-in, else one they added, else Apple's State of Mind.
    const m = rating(l?.m);
    if (m) {
      row.mood = m;
      tier.mood = 1;
    } else {
      const moods = ofKind(k, 'mood').filter((x) => !own(x));
      const added = moods.filter((x) => x.unit === 'mood (1-5)' && moodOf(x) != null);
      const felt = moods.filter((x) => x.unit !== 'mood (1-5)' && moodOf(x) != null);
      const use = added.length ? added : felt;
      if (use.length) {
        row.mood = use.reduce((n, x) => n + moodOf(x)!, 0) / use.length;
        tier.mood = maxTier(use);
      }
    }

    // The night's sleep that ended this morning: the longest, not a nap.
    const from = dayStart(k);
    const to = dayEnd(k);
    const night = sleeps.filter((x) => x.end! >= from && x.end! < to).sort((a, b) => minutesOf(b) - minutesOf(a))[0];
    if (night) {
      row.sleepMin = Math.round(minutesOf(night));
      tier.sleepMin = night.tier;
    }

    // Steps: each source's own total, and the highest of those (a phone and a watch count the
    // same walk). Within a source, the day's counts for parts of it add up, but a day's total
    // read twice (live from Health and again from its export) is the same total.
    const steps = new Map<string, { parts: number; total: number; evs: LifeEvent[] }>();
    for (const x of ofKind(k, 'steps')) {
      if (typeof x.value !== 'number' || !(x.value > 0)) continue;
      const t = steps.get(x.source) || { parts: 0, total: 0, evs: [] };
      if (dayTotal(x)) t.total = Math.max(t.total, x.value);
      else t.parts += x.value;
      t.evs.push(x);
      steps.set(x.source, t);
    }
    const most = [...steps.values()].map((t) => ({ n: Math.max(t.total, t.parts), evs: t.evs })).sort((a, b) => b.n - a.n)[0];
    if (most) {
      row.steps = Math.round(most.n);
      tier.steps = maxTier(most.evs);
    }

    // A workout: in Arise (its sessions, or football), or recorded by another app.
    const elsewhere = ofKind(k, 'workout').filter((x) => !own(x));
    row.trained = sessions.has(k) || elsewhere.length > 0;
    tier.trained = elsewhere.length ? maxTier(elsewhere, 2) : 1;

    if (talk.length) {
      row.people = talked.has(k);
      tier.people = 3;
    }

    const apps = ofKind(k, 'app');
    const screen = apps.reduce((n, x) => n + minutesOf(x), 0);
    if (screen > 0) {
      row.screenMin = Math.round(screen);
      tier.screenMin = maxTier(apps);
    }

    if (cal.length) {
      row.calMin = Math.round(timed.reduce((n, x) => n + Math.max(0, Math.min(x.end!, to) - Math.max(x.at, from)), 0) / 60000);
      tier.calMin = calTier;
    }

    // Quests due that day (not the few-times-a-week ones: any day will do for those).
    const due = quests.filter((q) => G.dueOn(q, k));
    if (due.length) {
      row.due = due.length;
      row.done = due.filter((q) => G.isDone(st.checks, k, q.id)).length;
    }
    out.push(row);
  }
  return out;
}
