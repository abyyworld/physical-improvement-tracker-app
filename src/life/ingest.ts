// Arise's own data in the life log: quests done, workouts, football, journal entries, weigh-ins,
// measures, milestones, new goals and questions asked to the coach, as tier-1 events (they're
// already sent to any AI the Player picked). A question about something only some AIs may read
// keeps that tier.
//
// The log follows the app: on start (which also brings in all of the history, once) and shortly
// after each save, what's new or changed goes in, and what was undone (a quest unticked, a workout
// deleted) goes out. Questions to the coach stay even after "New chat", since the chat only keeps
// its latest 200 messages and the log is the long-term record; the Player can delete them one by
// one (deleteCoachQuestion), and then they stay out.

import * as S from '../store';
import type { State } from '../store';
import { EXERCISES } from '../program.js';
import { cleanLifeEvent } from '../lib/validate';
import * as L from './log';
import { getKV, setKV } from './db';
import { forgetPrefs } from './policy';
import { dayKey, parseDay } from './dates';
import type { LifeEvent } from './types';

const EX = EXERCISES as Record<string, { name: string }>;
const KEEP = 'arise:chat:'; // never taken out again
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const firstLine = (t: string) => t.trim().split(/\n/)[0].trim();

// The time to file something under: when it happened if that was on its day, otherwise a set
// hour of its day (a quest ticked late for yesterday still belongs to yesterday).
function timeOn(k: string, t: number | undefined, hour = 12) {
  if (typeof t === 'number' && t > 0 && dayKey(t) === k) return t;
  const d = parseDay(k);
  d.setHours(hour);
  return d.getTime();
}

const ev = (e: Omit<LifeEvent, 'source' | 'tier'>): LifeEvent => ({ ...e, source: 'arise', tier: 1 });

// Every event Arise's data makes, with ids that stay the same each time.
export function ariseEvents(st: State): LifeEvent[] {
  const out: LifeEvent[] = [];
  const quests = new Map<string, { title: string; goal: string; amount?: { target: number; unit: string } }>();
  for (const g of st.goals) for (const q of g.quests) quests.set(q.id, { title: q.title, goal: g.title, amount: q.amount });

  for (const [k, day] of Object.entries(st.checks)) {
    for (const [qid, c] of Object.entries(day)) {
      const q = quests.get(qid);
      if (!c.done || !q) continue;
      const amount = c.amount != null && q.amount ? ` (${c.amount} of ${q.amount.target}${q.amount.unit ? ` ${q.amount.unit}` : ''})` : '';
      out.push(ev({ id: `arise:quest:${k}:${qid}`, kind: 'quest', at: timeOn(k, c.at), title: `Done: ${q.title}${amount}`, detail: `A quest for your goal "${q.goal}".`, ...(c.amount != null ? { value: c.amount, unit: q.amount?.unit || '' } : {}) }));
    }
  }

  for (const s of st.sessions) {
    const items = s.items.filter((it) => it.sets.length).map((it) => `${EX[it.ex]?.name || it.ex} ${it.sets.map((x) => x.r).join('/')}${it.setup ? ` (${it.setup})` : ''}`);
    const mins = s.finished > s.started && s.started ? Math.max(1, Math.round((s.finished - s.started) / 60000)) : undefined;
    const start = timeOn(s.date, s.started, 18);
    out.push(
      ev({
        id: `arise:workout:${s.id}`,
        kind: 'workout',
        at: start,
        ...(mins ? { end: start + mins * 60000, value: mins, unit: 'min' } : {}),
        title: `Workout: ${S.workoutName(s.workout, s)}`,
        detail: `${items.join('; ') || 'No sets logged.'}${s.easy ? ' Easy week.' : ''}${s.atHome ? ' At home, without the bar.' : ''}`,
      }),
    );
  }

  for (const k of st.football) out.push(ev({ id: `arise:football:${k}`, kind: 'play', at: timeOn(k, undefined, 17), title: 'Played football' }));

  // The day's check-in: the Player's words as a note, or how they slept, their energy and mood.
  for (const [k, l] of Object.entries(st.logs)) {
    const text = (l.t || '').trim();
    if (!text && !l.e && !l.s && !l.m) continue;
    const parts = [l.s && `Sleep ${l.s}/5.`, l.e && `Energy ${l.e}/5.`, l.m && `Mood ${l.m}/5.`].filter(Boolean);
    const rated = [l.s && `sleep ${l.s}/5`, l.e && `energy ${l.e}/5`, l.m && `mood ${l.m}/5`].filter(Boolean);
    out.push(
      ev({
        id: `arise:journal:${k}`,
        kind: text ? 'note' : 'mood',
        at: timeOn(k, l.at, 21),
        title: text ? `Journal: ${clip(firstLine(text), 90)}` : l.e && !l.s && !l.m ? `Energy ${l.e}/5` : `Check-in: ${rated.join(', ')}`,
        ...(text ? { detail: `${text}${parts.length ? `\n\n${parts.join(' ')}` : ''}` } : {}),
        ...(l.e ? { value: l.e, unit: 'energy (1-5)' } : l.m ? { value: l.m, unit: 'mood (1-5)' } : {}),
      }),
    );
  }

  for (const e of st.body.entries) {
    const parts = [e.weight != null ? `${e.weight} kg` : '', e.waist != null ? `waist ${e.waist} cm` : '', e.shoulders != null ? `shoulders ${e.shoulders} cm` : ''].filter(Boolean);
    out.push(ev({ id: `arise:body:${e.date}`, kind: 'health', at: timeOn(e.date, e.at, 8), title: `Weigh-in: ${parts.join(', ')}`, ...(e.weight != null ? { value: e.weight, unit: 'kg' } : {}) }));
  }

  for (const g of st.goals) {
    out.push(ev({ id: `arise:goal:${g.id}`, kind: 'event', at: timeOn(g.created, undefined, 9), title: `New goal: ${g.title}`, ...(g.why ? { detail: `Why: ${g.why}` } : {}) }));
    for (const m of g.milestones) if (m.done) out.push(ev({ id: `arise:milestone:${g.id}:${m.id}`, kind: 'event', at: timeOn(m.done, undefined, 12), title: `Milestone reached: ${m.title}`, detail: `On the way to "${g.title}".` }));
    for (const m of g.measures) {
      for (const [k, v] of Object.entries(st.values[m.id] || {})) {
        out.push(ev({ id: `arise:measure:${m.id}:${k}`, kind: 'other', at: timeOn(k, v.at), title: `${m.name}: ${v.v}${m.unit ? ` ${m.unit}` : ''}`, detail: `A measure for your goal "${g.title}".`, value: v.v, unit: m.unit }));
      }
    }
  }

  for (const m of st.ai.chat) {
    if (m.role !== 'user' || m.error || !m.at || !m.text.trim()) continue;
    // A question with something from the life log in it ("Ask your coach" on a pattern) keeps its tier.
    out.push({ ...ev({ id: `${KEEP}${m.at}`, kind: 'message', at: m.at, title: `Asked the coach: ${clip(firstLine(m.text), 90)}`, detail: m.text.trim().slice(0, 2000) }), ...(m.tier ? { tier: m.tier } : {}) });
  }
  return out;
}

// ---------- keeping the log in step

let known: Map<string, string> | null = null; // id -> what it held, for Arise's events in the log
let dropped = new Set<string>(); // questions to the coach the Player deleted from the log
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const print = (e: LifeEvent) => JSON.stringify(e);

async function loadKnown() {
  const [list, gone] = await Promise.all([L.eventsBetween(-Infinity, Infinity, { sources: ['arise'], limit: 100000 }), getKV<string[]>('dropped')]);
  known = new Map(list.map((e) => [e.id, print(e)]));
  dropped = new Set(Array.isArray(gone) ? gone : []);
}

export const isCoachQuestion = (id: string) => typeof id === 'string' && id.startsWith(KEEP);

// The Player deletes a question they asked the coach from the log. It isn't brought back from
// the chat, which keeps it until "New chat".
export async function deleteCoachQuestion(id: string): Promise<void> {
  if (!isCoachQuestion(id)) return;
  dropped.add(id);
  known?.delete(id);
  await setKV('dropped', [...new Set([...((await getKV<string[]>('dropped')) || []), id])].slice(-5000));
  await L.removeIds([id]);
}

// Brings the log in step with the app's data now.
export function ingestNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  // (`finally` after the assignment: a run with nothing to do finishes without waiting at all.)
  running = (async () => {
    try {
      do {
        again = false;
        if (!known) await loadKnown();
        // As the log keeps them (checked and cleaned), so an unchanged event never counts as changed.
        const want = ariseEvents(S.state)
          .filter((e) => !dropped.has(e.id))
          .map(cleanLifeEvent)
          .filter((e): e is LifeEvent => !!e);
        const ids = new Set(want.map((e) => e.id));
        const put = want.filter((e) => known!.get(e.id) !== print(e));
        const gone = [...known!.keys()].filter((id) => !ids.has(id) && !id.startsWith(KEEP));
        if (put.length) await L.upsertEvents(put);
        if (gone.length) await L.removeIds(gone);
        for (const e of put) known!.set(e.id, print(e));
        for (const id of gone) known!.delete(id);
      } while (again);
    } catch {
      known = null; // read it again next time
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

// After a save: soon, not on every keystroke or ticked set.
export function ingestSoon(delay = 2000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    ingestNow();
  }, delay);
}

let started = false;

// On start: everything once, then after each save. When the data on this device is wiped or
// replaced by another account's, the life log and its memory go too, and so do the Player's
// life log switches (whether less private AIs may read it is theirs to say, not the next person's).
export function initIngest({ onReset }: { onReset?: () => void } = {}) {
  if (started) return;
  started = true;
  S.onSave(() => ingestSoon());
  S.onReset(() => {
    known = null; // read again from the log next time
    forgetPrefs();
    L.eraseAll()
      .catch(() => {})
      .finally(() => onReset?.());
  });
  // The Player emptied the log: the app's own data comes back in (it's still in the app).
  L.onChange((c) => {
    if (c.type !== 'clear') return;
    known = null;
    ingestSoon(500);
  });
  ingestNow();
}
