// To-dos: one-off things to do, with a day (and a time) if they have one. Unlike quests, which come
// back on a schedule for a goal, a to-do is done once. Synced end-to-end encrypted with the rest.
//
// Each to-do keeps the time it last changed (`at`); a deleted one stays as a tombstone (`gone`)
// for a while, so a copy on another device that still has it can't bring it back. Two copies
// merge per to-do: the later change wins.

export interface Todo {
  id: string;
  title: string;
  day?: string; // YYYY-MM-DD
  time?: string; // HH:MM, only with a day
  done?: number; // when it was done
  from?: string; // the app that added it (the web connector), if not the Player
  created: number;
  at: number; // when it last changed
  gone?: true; // deleted
}
export type Todos = Record<string, Todo>;

export const MAX_TODOS = 1000;
export const TITLE_MAX = 200;
const KEEP_GONE = 180 * 86_400_000;
const KEEP_DONE = 400 * 86_400_000;

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15;
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id) || !isTime(r.at)) return null;
  const created = isTime(r.created) ? r.created : r.at;
  if (r.gone === true) return { id: r.id, title: '', created, at: r.at, gone: true };
  const title = line(r.title, TITLE_MAX);
  if (!title) return null;
  const out: Todo = { id: r.id, title, created, at: r.at };
  if (typeof r.day === 'string' && DAY.test(r.day)) {
    out.day = r.day;
    if (typeof r.time === 'string' && TIME.test(r.time)) out.time = r.time;
  }
  if (isTime(r.done)) out.done = r.done;
  const from = line(r.from, 40);
  if (from) out.from = from;
  return out;
}

// Old tombstones and long-done to-dos go; then, past the most kept, the oldest changes go first
// (to-dos and deletions each on their own, so a crowd of to-dos never pushes out a deletion that
// keeps one from coming back). In a fixed order (by id), so the same to-dos always save the same.
// (A to-do counts as data even when deleted: store.ts isEmpty.)
export function cleanTodos(raw: unknown, now = Date.now()): Todos {
  const out: Todo[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const t = cleanTodo(v);
      if (!t || t.id !== k) continue;
      if (t.gone && now - t.at > KEEP_GONE) continue;
      if (t.done && now - t.done > KEEP_DONE) continue;
      out.push(t);
    }
  }
  const newest = (list: Todo[]) => list.sort((a, b) => b.at - a.at).slice(0, MAX_TODOS);
  const kept = [...newest(out.filter((t) => !t.gone)), ...newest(out.filter((t) => t.gone))];
  kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.fromEntries(kept.map((t) => [t.id, t]));
}

// Each to-do from whichever copy changed it last (a deletion is a change too).
export function mergeTodos(a: Todos, b: Todos, now = Date.now()): Todos {
  const out: Todos = { ...a };
  for (const [id, t] of Object.entries(b)) if (!out[id] || t.at > out[id].at) out[id] = t;
  return cleanTodos(out, now);
}

export const live = (todos: Todos) => Object.values(todos).filter((t) => !t.gone);
export const hasTodos = (todos: Todos) => live(todos).length > 0;

const order = (a: Todo, b: Todo) => (a.day || '9999').localeCompare(b.day || '9999') || (a.time || '99').localeCompare(b.time || '99') || a.created - b.created;

// What's on the list for day k: not done and due by then (or with no day), then what was done that
// day. Later days wait for their day.
export function forDay(todos: Todos, k: string, dayOf: (t: number) => string): { open: Todo[]; done: Todo[]; later: Todo[] } {
  const all = live(todos);
  return {
    open: all.filter((t) => !t.done && (!t.day || t.day <= k)).sort(order),
    done: all.filter((t) => t.done && dayOf(t.done) === k).sort((a, b) => a.done! - b.done!),
    later: all.filter((t) => !t.done && t.day && t.day > k).sort(order),
  };
}
