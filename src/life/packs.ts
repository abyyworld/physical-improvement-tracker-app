// How the life log syncs, without the cloud or the database: which pack each thing goes in, and
// how two copies of a pack come together. Pure, so it's tested on its own (packs.test.ts).
//
// The life log goes to the cloud in packs, each sealed on its own (seal.ts, cloud.ts), so a change
// sends one pack, never the whole log, and the main cloud copy (sync.ts) doesn't grow:
//   e:2026-10  the events of one calendar month (UTC, so every device files an event in the same
//              pack whatever its time zone)
//   s:2026     the summaries of one year's days, weeks and months
//   mem        the facts, "Stop learning", and what the Player deleted in one go (wipes)
//
// Two copies of a pack come together item by item. Each item has a time it last changed (an
// event's `m`, a fact's or a summary's `at`), and each item deleted one by one leaves a tombstone
// with the time it was deleted. For each item the newest wins, and a deletion wins a tie, so
// nothing deleted on one device comes back from another that still had it. A Player's own fact
// (one they added or edited) always beats the AI's version of it, and so does their deleting it.
// Wipes (validate.ts, LifeWipe) delete everything they cover that's older than they are, even
// what the device that made them never had. Tombstones and wipes are kept for 400 days, like the
// change stamps of the main copy (lib/merge.ts).

import { cleanLifeEvent, cleanLifeFact, cleanLifePrefs, cleanLifeSummary, cleanLifeTombs, cleanLifeWipe, type LifeFact, type LifeSummary, type LifeWipe } from '../lib/validate';
import type { LifeEvent } from './types';

export const LIFE_SCHEMA = 1; // bump when a pack's shape changes in a way an older app would lose
export const MEM = 'mem';
export const TOMB_KEEP = 400 * 864e5;
const MAX_WIPES = 500;

// ---------- which pack

export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);
export const eventPack = (e: { at: number }) => `e:${monthOf(e.at)}`;
export const summaryPack = (id: string) => `s:${id.slice(2, 6)}`;
export const isPackKey = (k: unknown): k is string => typeof k === 'string' && (k === MEM || /^e:\d{4}-(0[1-9]|1[0-2])$/.test(k) || /^s:\d{4}$/.test(k));
// The span of a month's pack, [from, to) in ms.
export function monthSpan(key: string): [number, number] {
  const [y, m] = key.slice(2).split('-').map(Number);
  return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}
export const packKind = (key: string): 'e' | 's' | 'mem' => (key === MEM ? 'mem' : (key[0] as 'e' | 's'));

// Arise's own events are made again on each device from the app's data, which syncs on its own
// (ingest.ts). Only the questions asked to the coach are kept for good, so they sync.
export const syncable = (e: { id: string; source: string }) => e.source !== 'arise' || e.id.startsWith('arise:chat:');
// A question to the coach never changes once asked, so it counts as changed when it was asked.
// Then the Player deleting it on one device beats every device's copy, even one taken in from the
// chat later (ingest.ts), and it stays deleted.
export const askedCoach = (e: { id: string; source: string }) => e.source === 'arise' && e.id.startsWith('arise:chat:');

// ---------- what's in a pack

export type SyncedEvent = LifeEvent & { m: number }; // m: when it last changed (0: before sync existed)
export interface SyncedPrefs {
  paused: boolean;
  at: number;
}
export interface Content {
  events: SyncedEvent[]; // e: packs
  sums: LifeSummary[]; // s: packs
  facts: LifeFact[]; // mem
  tombs: Record<string, number>; // id -> when it was deleted
  prefs: SyncedPrefs; // mem
  wipes: LifeWipe[]; // mem
}

export const emptyContent = (): Content => ({ events: [], sums: [], facts: [], tombs: {}, prefs: { paused: false, at: 0 }, wipes: [] });
export const isEmpty = (c: Content) => !c.events.length && !c.sums.length && !c.facts.length && !Object.keys(c.tombs).length && !c.prefs.at && !c.wipes.length;

const clock = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : 0);

export function cleanEvent(raw: unknown): SyncedEvent | null {
  const e = cleanLifeEvent(raw);
  return e && syncable(e) ? { ...e, m: clock((raw as { m?: unknown }).m) } : null;
}

// A pack as it came from the cloud (or this device's database), through the same checks as
// everything else. Anything that isn't this pack's own goes.
export function cleanContent(key: string, raw: unknown): Content {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const c = emptyContent();
  c.tombs = cleanLifeTombs(r.tombs);
  const kind = packKind(key);
  if (kind === 'e') c.events = list(r.events).map(cleanEvent).filter((e): e is SyncedEvent => !!e && eventPack(e) === key);
  else if (kind === 's') c.sums = list(r.sums).map(cleanLifeSummary).filter((s): s is LifeSummary => !!s && summaryPack(s.id) === key);
  else {
    c.facts = list(r.facts).map(cleanLifeFact).filter((f): f is LifeFact => !!f);
    const p = (r.prefs && typeof r.prefs === 'object' ? r.prefs : {}) as Record<string, unknown>;
    c.prefs = { paused: p.paused === true, at: clock(p.at) };
    c.wipes = list(r.wipes).map(cleanLifeWipe).filter((w): w is LifeWipe => !!w);
  }
  return c;
}

// The same pack always looks the same (items by id, tombstones and wipes in order), so two
// devices that agree write the same thing, and an unchanged pack isn't sent again.
export function canonical(key: string, c: Content): string {
  const byId = <T extends { id: string }>(l: T[]) => [...l].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tombs = Object.fromEntries(Object.entries(c.tombs).sort(([a], [b]) => (a < b ? -1 : 1)));
  const kind = packKind(key);
  const body: Record<string, unknown> = { v: 1, k: key, tombs };
  if (kind === 'e') body.events = byId(c.events);
  else if (kind === 's') body.sums = byId(c.sums);
  else {
    body.facts = byId(c.facts);
    body.prefs = c.prefs;
    body.wipes = sortWipes(c.wipes);
  }
  return JSON.stringify(body);
}

// ---------- wipes

const wipeKey = (w: LifeWipe) => `${w.at}|${w.what}|${w.source ?? ''}|${w.from ?? ''}|${w.to ?? ''}`;
const sortWipes = (l: LifeWipe[]) => [...l].sort((a, b) => a.at - b.at || (wipeKey(a) < wipeKey(b) ? -1 : 1));

// Both lists, each wipe once, without the ones too old to matter (and at most the newest 500).
export function mergeWipes(a: readonly LifeWipe[], b: readonly LifeWipe[], now: number): LifeWipe[] {
  const m = new Map<string, LifeWipe>();
  for (const w of [...a, ...b]) if (now - w.at <= TOMB_KEEP) m.set(wipeKey(w), w);
  return sortWipes([...m.values()]).slice(-MAX_WIPES);
}

// Whether a wipe made at `w.at` covers this event, last changed at `e.m`.
export function wipesEvent(w: LifeWipe, e: SyncedEvent) {
  if (w.at < e.m) return false;
  if (w.what === 'all') return true;
  if (w.what !== 'events') return false;
  return (!w.source || w.source === e.source) && (w.from === undefined || e.at >= w.from) && (w.to === undefined || e.at < w.to);
}
const wipesMemory = (w: LifeWipe, at: number) => (w.what === 'all' || w.what === 'memory') && w.at >= at;

// ---------- two copies of one pack

interface Side<T> {
  items: T[];
  tombs: Record<string, number>;
}
interface Rules<T> {
  clock(x: T): number;
  player?(x: T): boolean; // the Player's own: beats the AI's version, and only a newer deletion beats it
  dead?(x: T): boolean; // covered by a wipe
}

// Determines the winner the same way on every device: the newer, or for two of the same time,
// the one whose text sorts last.
function newer<T>(a: T, b: T, r: Rules<T>): T {
  if (r.player) {
    const pa = r.player(a);
    if (pa !== r.player(b)) return pa ? a : b;
  }
  const d = r.clock(a) - r.clock(b);
  if (d) return d > 0 ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

// `staleBefore`: this device last synced the pack then, longer ago than tombstones are kept. What
// it had then and the other copy no longer has was deleted since, so it goes too.
function mergeSide<T extends { id: string }>(here: Side<T>, there: Side<T>, r: Rules<T>, now: number, staleBefore = 0): Side<T> {
  const a = new Map(here.items.map((x) => [x.id, x]));
  const b = new Map(there.items.map((x) => [x.id, x]));
  const ids = new Set([...a.keys(), ...b.keys(), ...Object.keys(here.tombs), ...Object.keys(there.tombs)]);
  const items: T[] = [];
  const tombs: Record<string, number> = {};
  for (const id of ids) {
    const va = a.get(id);
    const vb = b.get(id);
    let v = va && vb ? newer(va, vb, r) : va || vb;
    const ta = here.tombs[id];
    const tb = there.tombs[id];
    let t: number | undefined = ta === undefined ? tb : tb === undefined ? ta : Math.max(ta, tb);
    if (v && t !== undefined) {
      // A deletion wins over anything not newer than it, and (for facts) over any of the AI's.
      const gone = t >= r.clock(v) || (!!r.player && !r.player(v));
      if (gone) v = undefined;
      else t = undefined;
    }
    if (v && r.dead?.(v)) v = undefined;
    if (v && v === va && !vb && tb === undefined && staleBefore && r.clock(v) <= staleBefore) v = undefined;
    if (v) items.push(v);
    else if (t !== undefined && now - t <= TOMB_KEEP) tombs[id] = t;
  }
  return { items, tombs };
}

export interface MergeOptions {
  now: number;
  staleBefore?: number;
  wipes?: readonly LifeWipe[]; // for e: and s: packs, the wipes known now (the mem pack's)
}

// This device's copy of a pack and another's, together. Neither is changed.
export function mergeContent(key: string, here: Content, there: Content, { now, staleBefore = 0, wipes = [] }: MergeOptions): Content {
  const out = emptyContent();
  const kind = packKind(key);
  if (kind === 'e') {
    const s = mergeSide(
      { items: here.events, tombs: here.tombs },
      { items: there.events, tombs: there.tombs },
      { clock: (e) => e.m, dead: (e) => wipes.some((w) => wipesEvent(w, e)) },
      now,
      staleBefore,
    );
    out.events = s.items;
    out.tombs = s.tombs;
  } else if (kind === 's') {
    const s = mergeSide({ items: here.sums, tombs: here.tombs }, { items: there.sums, tombs: there.tombs }, { clock: (x) => x.at, dead: (x) => wipes.some((w) => wipesMemory(w, x.at)) }, now, staleBefore);
    out.sums = s.items;
    out.tombs = s.tombs;
  } else {
    out.wipes = mergeWipes(here.wipes, there.wipes, now);
    const s = mergeSide(
      { items: here.facts, tombs: here.tombs },
      { items: there.facts, tombs: there.tombs },
      { clock: (f) => f.at, player: (f) => f.from === 'you', dead: (f) => out.wipes.some((w) => wipesMemory(w, f.at)) },
      now,
      staleBefore,
    );
    out.facts = s.items;
    out.tombs = s.tombs;
    const [p, q] = [here.prefs, there.prefs];
    out.prefs = p.at !== q.at ? (p.at > q.at ? p : q) : { paused: p.paused || q.paused, at: p.at };
  }
  return out;
}

// One copy on its own, tidied the same way (old tombstones gone, wipes applied): what this device
// sends when the cloud has nothing newer.
export const tidy = (key: string, c: Content, opts: MergeOptions) => mergeContent(key, c, emptyContent(), { ...opts, staleBefore: 0 });

// The prefs that sync, from the device's own.
export function syncedPrefs(raw: unknown): SyncedPrefs {
  const p = cleanLifePrefs(raw);
  return { paused: p.paused, at: p.pausedAt || 0 };
}
