// The life log: everything that happened in the Player's life, from Arise itself, their own
// notes and the exports they import, kept on this device in IndexedDB (see db.ts). With an
// account it syncs, sealed (cloud.ts): each change here notes what the sync must send (journal.ts).
//
// For importers: call addEvents(batch) with batches of a few hundred LifeEvents. Each one is
// checked (cleanLifeEvent in lib/validate.ts); bad ones are dropped, and ones already in the log
// (same id) are skipped, so importing the same file twice adds nothing. It resolves with how many
// were new. onChange tells every screen and the memory what changed.

import { cleanLifeEvent, cleanLifeFact, cleanLifeSummary, type LifeFact, type LifeSummary, type LifeWipe } from '../lib/validate';
import type { LifeEvent, LifeKind, LifeSource } from './types';
import { LIFE_SOURCES } from './tiers';
import { addDays, dayEnd, dayKey, dayStart } from './dates';
import { done, onOtherTabs, open, req, tellOtherTabs } from './db';
import { addTomb, addWipe, clearNotes, dirtied, markDirty } from './journal';
import { askedCoach, eventPack, MEM, syncable } from './packs';

export type { LifeEvent, LifeKind, LifeSource };
export { LifeLogError } from './db';

// What a record in the database looks like: the event plus its words, for search, and when it
// last changed here (for the sync, packs.ts).
type Row = LifeEvent & { w: string[]; m?: number };

const BATCH = 1000; // events per transaction
const FAR = 8.64e15;

// ---------- words, for search

const STOP = new Set(
  'a an the and or but of to in on at by for with from into onto about as is are was were be been being am do does did done doing have has had having i me my mine myself you your yours we our us they them their he she him her his it its this that these those there here what which who whom whose when where why how much many any some all no not yes can could would should will shall may might must just also very really so than then too up down out over under again more most other such only own same few each both if while until because before after during between through above below off once ever lot get got go went going gone thing things stuff tell show find look let make made know'.split(
    ' ',
  ),
);

// Words about when, which the question's date (dates.ts) already covers.
for (const w of 'yesterday today tonight tomorrow morning afternoon evening night week weeks weekend month months year years ago day days recently lately since past previous last first next ever often usually monday tuesday wednesday thursday friday saturday sunday'.split(' ')) STOP.add(w);

// Lower case, accents gone, split on anything that isn't a letter or a digit.
export function words(text: string): string[] {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && w.length <= 40);
}

// The words a row is found by: its title and detail, and the source's name.
function rowWords(e: LifeEvent): string[] {
  const set = new Set([...words(e.title), ...words((e.detail || '').slice(0, 1500)), e.source]);
  return [...set].slice(0, 120);
}

// The words to look for in a question: no little words, and a light trim so "watched" finds
// "watching" (every word is matched as the start of a word).
export function queryWords(text: string): string[] {
  const out: string[] = [];
  for (let w of words(text)) {
    if (STOP.has(w)) continue;
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length >= 2 && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

const hasWord = (w: string[], q: string) => w.some((x) => x.startsWith(q));

// ---------- change notices

export interface LifeChange {
  type: 'add' | 'update' | 'delete' | 'clear' | 'sync'; // sync: from another device (cloud.ts)
  count: number;
  days: string[]; // the local days (2026-10-16) that changed; empty for 'clear'
  sources: LifeSource[];
  memory?: boolean; // sync: facts, summaries or "Stop learning" changed too
}
const listeners = new Set<(c: LifeChange) => void>();
let othersHeard = false;
export function onChange(cb: (c: LifeChange) => void): () => void {
  listeners.add(cb);
  if (!othersHeard) {
    othersHeard = true;
    // Another tab or window emptied the log: this one's memory and screens catch up too.
    onOtherTabs((type) => {
      if (type !== 'clear') return;
      beforeClear();
      emit({ type: 'clear', count: 0, days: [], sources: [] });
    });
  }
  return () => listeners.delete(cb);
}

// Told right before the log is emptied, so work in progress (the memory learning) stops first and
// nothing it was about to write lands after the wipe. Also before a wipe from another device is
// taken in (cloud.ts).
const clearing = new Set<() => void>();
export function onClearing(cb: () => void): () => void {
  clearing.add(cb);
  return () => clearing.delete(cb);
}
export function beforeClear() {
  for (const cb of [...clearing]) {
    try {
      cb();
    } catch {}
  }
}

export function emit(c: LifeChange) {
  if (!c.count && c.type !== 'clear') return;
  for (const cb of [...listeners]) {
    try {
      cb(c);
    } catch {}
  }
}

// `m`: when it changed (now, unless it comes from another device with its own time).
export const toRow = (e: LifeEvent, m = Date.now()): Row => ({ ...e, w: rowWords(e), m });
// When a row last changed (0: before the sync kept it).
export const changedAt = (r: unknown) => {
  const m = (r as { m?: unknown } | null)?.m;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 0;
};
// When a deletion of something last changed at `m` is noted: now, but never before that (another
// device's clock may be ahead of this one's), so it deletes it everywhere (packs.ts: a deletion
// wins over anything not newer than it).
export const deletedAt = (m: number, now = Date.now()) => Math.max(now, m);
// Rows read back go through the same check as everything else from storage.
export function fromRow(r: unknown): LifeEvent | null {
  if (!r || typeof r !== 'object') return null;
  const { w: _w, m: _m, ...e } = r as Row;
  return cleanLifeEvent(e);
}
const rows = (list: unknown[]) => list.map(fromRow).filter((e): e is LifeEvent => !!e);

// ---------- writing

// Adds new events; ones already in the log (same id) stay as they are. Resolves with how many were new.
export async function addEvents(events: readonly unknown[]): Promise<number> {
  const clean = (Array.isArray(events) ? events : []).map(cleanLifeEvent).filter((e): e is LifeEvent => !!e);
  if (!clean.length) return 0;
  const db = await open();
  let added = 0;
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const packs = new Set<string>();
  for (let i = 0; i < clean.length; i += BATCH) {
    const tx = db.transaction(['events', 'sync'], 'readwrite');
    const store = tx.objectStore('events');
    for (const e of clean.slice(i, i + BATCH)) {
      const r = store.add(toRow(e));
      r.onsuccess = () => {
        added++;
        days.add(dayKey(e.at));
        sources.add(e.source);
        touch(tx, packs, e);
      };
      // Already there: not an error, and the rest of the batch goes on.
      r.onerror = (ev) => {
        if (r.error?.name === 'ConstraintError') {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };
    }
    await done(tx);
  }
  if (packs.size) dirtied();
  emit({ type: 'add', count: added, days: [...days].sort(), sources: [...sources] });
  return added;
}

// The pack of an event that syncs changed: noted once per pack in this change.
function touch(tx: IDBTransaction, packs: Set<string>, e: { id: string; source: string; at: number }) {
  if (!syncable(e)) return;
  const p = eventPack(e);
  if (packs.has(p)) return;
  packs.add(p);
  markDirty(tx, [p]);
}

const same = (a: LifeEvent, b: LifeEvent) => JSON.stringify(a) === JSON.stringify(b);

// Adds events, or replaces the ones that changed (for Arise's own data, which can be edited).
// Resolves with how many were added or changed.
export async function upsertEvents(events: readonly unknown[]): Promise<number> {
  const clean = (Array.isArray(events) ? events : []).map(cleanLifeEvent).filter((e): e is LifeEvent => !!e);
  if (!clean.length) return 0;
  const db = await open();
  let changed = 0;
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const packs = new Set<string>();
  for (let i = 0; i < clean.length; i += BATCH) {
    const tx = db.transaction(['events', 'sync', 'tomb'], 'readwrite');
    const store = tx.objectStore('events');
    const tombs = tx.objectStore('tomb');
    for (const e of clean.slice(i, i + BATCH)) {
      const g = store.get(e.id);
      g.onsuccess = () => {
        const old = g.result ? fromRow(g.result) : null;
        if (old && same(old, e)) return;
        const now = Date.now();
        const m = askedCoach(e) ? e.at : now;
        const put = () => {
          store.put(toRow(e, m));
          changed++;
          days.add(dayKey(e.at));
          if (old) days.add(dayKey(old.at));
          sources.add(e.source);
          touch(tx, packs, e);
          // Moved to another month: it leaves that month's pack.
          if (old && syncable(old) && eventPack(old) !== eventPack(e)) {
            addTomb(tx, eventPack(old), old.id, deletedAt(changedAt(g.result), now));
            touch(tx, packs, old);
          }
        };
        if (old || m >= now || !syncable(e)) return put();
        // Deleted (here or on another device) after it last changed: it stays deleted.
        const t = tombs.get(`${eventPack(e)}|${e.id}`);
        t.onsuccess = () => {
          const tm = (t.result as { m?: unknown } | undefined)?.m;
          if (!(typeof tm === 'number' && tm >= m)) put();
        };
      };
    }
    await done(tx);
  }
  if (packs.size) dirtied();
  emit({ type: 'update', count: changed, days: [...days].sort(), sources: [...sources] });
  return changed;
}

// Removes events by id. Resolves with how many were there.
export async function removeIds(ids: readonly string[]): Promise<number> {
  const list = [...new Set(ids.filter((id) => typeof id === 'string'))];
  if (!list.length) return 0;
  const db = await open();
  let n = 0;
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const packs = new Set<string>();
  for (let i = 0; i < list.length; i += BATCH) {
    const tx = db.transaction(['events', 'sync', 'tomb'], 'readwrite');
    const store = tx.objectStore('events');
    for (const id of list.slice(i, i + BATCH)) {
      const g = store.get(id);
      g.onsuccess = () => {
        const row = g.result as Row | undefined;
        if (!row) return;
        store.delete(id);
        n++;
        days.add(dayKey(row.at));
        sources.add(row.source);
        // Every device deletes it too (packs.ts).
        if (syncable(row)) addTomb(tx, eventPack(row), id, deletedAt(changedAt(row)));
        touch(tx, packs, row);
      };
    }
    await done(tx);
  }
  if (packs.size) dirtied();
  emit({ type: 'delete', count: n, days: [...days].sort(), sources: [...sources] });
  return n;
}

// Deletes what matches: one source, a time range [from, to), or both. With neither, everything
// in the log (the memory stays; see eraseAll for that). Resolves with how many went, and their days.
export async function deleteWhereDays({ source, from, to }: { source?: LifeSource; from?: number; to?: number } = {}): Promise<{ deleted: number; days: string[] }> {
  if (source !== undefined && !LIFE_SOURCES.includes(source)) return { deleted: 0, days: [] };
  const db = await open();
  const tx = db.transaction(['events', 'sync'], 'readwrite');
  const store = tx.objectStore('events');
  const lo = typeof from === 'number' ? from : -Infinity;
  const hi = typeof to === 'number' ? to : Infinity;
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const packs = new Set<string>();
  let n = 0;
  let newest = 0; // the latest change of what's deleted
  // Every device deletes the same, even what this one never had (packs.ts).
  const wipe: LifeWipe = { at: Date.now(), what: 'events' };
  if (source) wipe.source = source;
  if (typeof from === 'number' && Number.isFinite(from)) wipe.from = from;
  if (typeof to === 'number' && Number.isFinite(to)) wipe.to = to;
  const cursor = source ? store.index('source_at').openCursor(IDBKeyRange.bound([source, lo], [source, hi], false, true)) : store.index('at').openCursor(IDBKeyRange.bound(lo, hi, false, true));
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) {
      wipe.at = deletedAt(newest, wipe.at);
      addWipe(tx, wipe);
      markDirty(tx, [MEM]);
      return;
    }
    const row = c.value as Row;
    days.add(dayKey(row.at));
    sources.add(row.source);
    touch(tx, packs, row);
    if (syncable(row)) newest = Math.max(newest, changedAt(row));
    c.delete();
    n++;
    c.continue();
  };
  await done(tx);
  dirtied();
  emit({ type: 'delete', count: n, days: [...days].sort(), sources: [...sources] });
  return { deleted: n, days: [...days].sort() };
}

export async function deleteWhere(opts: { source?: LifeSource; from?: number; to?: number } = {}): Promise<number> {
  return (await deleteWhereDays(opts)).deleted;
}

// Everything on this device goes: the log, the summaries, the facts. `everywhere`: the Player
// deleted it all (What Arise knows, Delete everything), so it goes from their other devices and the
// cloud too. Otherwise only here (Erase all data, or another person's data taking this device's
// place), and so does all the sync knew: the cloud keeps its copy.
export async function eraseAll({ everywhere = false }: { everywhere?: boolean } = {}): Promise<void> {
  beforeClear();
  const db = await open();
  const tx = db.transaction(['events', 'summaries', 'facts', 'kv', 'sync', 'tomb'], 'readwrite');
  const clear = () => {
    for (const s of ['events', 'summaries', 'facts', 'kv']) tx.objectStore(s).clear();
  };
  if (everywhere) {
    const facts = tx.objectStore('facts').getAll();
    const sums = tx.objectStore('summaries').getAll();
    const state = tx.objectStore('sync').get('state');
    // The latest change of anything here: the wipe is never older than what it deletes.
    let newest = 0;
    const events = tx.objectStore('events').openCursor();
    events.onsuccess = () => {
      const cur = events.result;
      if (!cur) return then();
      newest = Math.max(newest, changedAt(cur.value));
      cur.continue();
    };
    const atOf = (x: unknown) => changedAt({ m: (x as { at?: unknown } | null)?.at });
    let left = 4;
    const then = () => {
      if (--left) return;
      const now = Date.now();
      // The facts by name too, so an AI's older copy of one on another device can't bring it back.
      for (const f of facts.result) addTomb(tx, MEM, String((f as { id?: unknown }).id), deletedAt(atOf(f), now));
      for (const x of [...facts.result, ...sums.result]) newest = Math.max(newest, atOf(x));
      addWipe(tx, { at: deletedAt(newest, now), what: 'all' });
      // Every pack in the cloud is sent again, empty.
      const known = Object.keys((state.result as { v?: { packs?: object } } | undefined)?.v?.packs || {});
      markDirty(tx, [MEM, ...known]);
      clear();
    };
    facts.onsuccess = then;
    sums.onsuccess = then;
    state.onsuccess = then;
  } else {
    clear();
    clearNotes(tx);
  }
  await done(tx);
  if (everywhere) dirtied();
  emit({ type: 'clear', count: 0, days: [], sources: [] });
  tellOtherTabs('clear');
}

// ---------- reading

export interface Filter {
  sources?: readonly LifeSource[];
  kinds?: readonly LifeKind[];
  limit?: number;
  newest?: boolean; // newest first (default: oldest first)
}

// Events that started in [from, to).
export async function eventsBetween(from: number, to: number, { sources, kinds, limit = 5000, newest = false }: Filter = {}): Promise<LifeEvent[]> {
  if (!(to > from)) return [];
  const db = await open();
  const store = db.transaction('events').objectStore('events');
  const max = Math.max(1, Math.min(100000, Math.floor(limit)));
  const src = sources?.length ? new Set(sources) : null;
  const kd = kinds?.length ? new Set(kinds) : null;
  // One source: its own index already holds only its events.
  const one = src && src.size === 1 ? [...src][0] : null;
  const range = one ? IDBKeyRange.bound([one, from], [one, to], false, true) : IDBKeyRange.bound(from, to, false, true);
  const index = store.index(one ? 'source_at' : 'at');
  if (!newest && !kd && (!src || one)) return rows(await req(index.getAll(range, max)));
  const out: LifeEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const c = index.openCursor(range, newest ? 'prev' : 'next');
    c.onerror = () => reject(c.error);
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve();
      const row = cur.value as Row;
      if ((!src || src.has(row.source)) && (!kd || kd.has(row.kind))) {
        const e = fromRow(row);
        if (e) out.push(e);
        if (out.length >= max) return resolve();
      }
      cur.continue();
    };
  });
  return out;
}

export async function getEvent(id: string): Promise<LifeEvent | null> {
  const db = await open();
  return fromRow(await req(db.transaction('events').objectStore('events').get(id)));
}

// The local days that have anything in the log, newest first, before `before` (a time).
export async function daysWithEvents({ before = FAR, after = -Infinity, limit = 60 }: { before?: number; after?: number; limit?: number } = {}): Promise<string[]> {
  const db = await open();
  const index = db.transaction('events').objectStore('events').index('at');
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const c = index.openCursor(IDBKeyRange.bound(after, before, false, true), 'prev');
    c.onerror = () => reject(c.error);
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve();
      const k = dayKey(cur.key as number);
      out.push(k);
      if (out.length >= limit) return resolve();
      // Straight on to the last event of an earlier day.
      const [y, m, d] = k.split('-').map(Number);
      const start = new Date(y, m - 1, d).getTime();
      if (start - 1 <= after) return resolve();
      cur.continue(start - 1);
    };
  });
  return out;
}

// How many events each local day in [from, to) holds, by day (2026-10-16); days with none are
// left out. One count per day from the time index, so a month full of browser history costs no
// more than a quiet one (the calendar in Your days).
export async function countByDay(from: number, to: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return out;
  const days: [string, number, number][] = [];
  for (let k = dayKey(from); dayStart(k) < to && days.length < 400; k = addDays(k, 1)) days.push([k, Math.max(from, dayStart(k)), Math.min(to, dayEnd(k))]);
  const db = await open();
  const index = db.transaction('events').objectStore('events').index('at');
  const counts = await Promise.all(days.map(([, lo, hi]) => req(index.count(IDBKeyRange.bound(lo, hi, false, true)))));
  days.forEach(([k], i) => {
    if (counts[i]) out[k] = counts[i];
  });
  return out;
}

export async function count(): Promise<number> {
  const db = await open();
  return req(db.transaction('events').objectStore('events').count());
}

// Whether the log holds anything of the Player's own beyond what Arise makes from the app's data
// (which the app's own check covers): notes, imports, questions to the coach, or anything learned.
// Asked before another account's data takes this device's place (src/sync.ts). False when this
// browser keeps no log at all; when the log can't be read, false too, or with `strict` (for the
// question about another account's data, life/cloud.ts) the error, so nobody's log is taken for
// empty.
export async function holdsOwnData({ strict = false }: { strict?: boolean } = {}): Promise<boolean> {
  try {
    const db = await open();
    const tx = db.transaction(['events', 'summaries', 'facts']);
    const ev = tx.objectStore('events');
    const [facts, sums, all, arise, asked] = await Promise.all([
      req(tx.objectStore('facts').count()),
      req(tx.objectStore('summaries').count()),
      req(ev.count()),
      req(ev.index('source_at').count(IDBKeyRange.bound(['arise', -Infinity], ['arise', Infinity]))),
      req(ev.count(IDBKeyRange.bound('arise:chat:', 'arise:chat:\uffff'))),
    ]);
    return facts + sums + asked > 0 || all > arise;
  } catch (err) {
    if (strict && hasLifeDB()) throw err;
    return false;
  }
}

// Whether this browser can keep a life log at all (it has an on-device database).
export const hasLifeDB = () => !!(globalThis as { indexedDB?: unknown }).indexedDB;

export async function countBySource(): Promise<Partial<Record<LifeSource, number>>> {
  const db = await open();
  const index = db.transaction('events').objectStore('events').index('source_at');
  const counts = await Promise.all(LIFE_SOURCES.map((s) => req(index.count(IDBKeyRange.bound([s, -Infinity], [s, Infinity])))));
  const out: Partial<Record<LifeSource, number>> = {};
  LIFE_SOURCES.forEach((s, i) => {
    if (counts[i]) out[s] = counts[i];
  });
  return out;
}

// The time of the oldest and newest events, or null for an empty log.
export async function span(): Promise<{ first: number; last: number } | null> {
  const db = await open();
  const index = db.transaction('events').objectStore('events').index('at');
  const edge = (dir: IDBCursorDirection) =>
    new Promise<number | null>((resolve, reject) => {
      const c = index.openKeyCursor(null, dir);
      c.onsuccess = () => resolve(c.result ? (c.result.key as number) : null);
      c.onerror = () => reject(c.error);
    });
  const [first, last] = await Promise.all([edge('next'), edge('prev')]);
  return first == null || last == null ? null : { first, last };
}

// ---------- search
//
// Every word of the question has to start a word in the event's title or detail (or be its
// source's name), newest first. The rarest word is looked up in the word index; when every word
// is common, the log is read a month at a time from the newest end until there are enough.
// `any`: events with at least one of the words, the ones with the most first.

const INDEX_MAX = 5000;
const WINDOW = 31 * 864e5;

export interface SearchOptions {
  from?: number;
  to?: number;
  limit?: number;
  any?: boolean;
}

export async function search(text: string, { from = -Infinity, to = Infinity, limit = 50, any = false }: SearchOptions = {}): Promise<LifeEvent[]> {
  const q = queryWords(text);
  if (!q.length) return [];
  const max = Math.max(1, Math.min(1000, Math.floor(limit)));
  const db = await open();
  const prefix = (w: string) => IDBKeyRange.bound(w, `${w}￿`);
  const wIndex = () => db.transaction('events').objectStore('events').index('w');
  const sizes = await Promise.all(q.map((w) => req(wIndex().count(prefix(w)))));
  const inRange = (r: Row) => r.at >= from && r.at < to;
  const score = (r: Row) => q.reduce((n, w) => n + (hasWord(r.w, w) ? 1 : 0), 0);

  if (!any) {
    if (sizes.some((n) => n === 0)) return [];
    const rare = sizes.indexOf(Math.min(...sizes));
    if (sizes[rare] <= INDEX_MAX) {
      const seen = new Set<string>();
      const hits = (await req(wIndex().getAll(prefix(q[rare])))) as Row[];
      const ok = hits.filter((r) => !seen.has(r.id) && !!seen.add(r.id) && inRange(r) && q.every((w) => hasWord(r.w, w)));
      return rows(ok.sort((a, b) => b.at - a.at).slice(0, max));
    }
    return rows(await scan(db, from, to, max, (r) => q.every((w) => hasWord(r.w, w))));
  }

  // Any of the words: the less common ones through the index.
  const found = new Map<string, Row>();
  const usable = q.filter((_, i) => sizes[i] > 0 && sizes[i] <= INDEX_MAX);
  for (const w of usable) for (const r of (await req(wIndex().getAll(prefix(w)))) as Row[]) if (inRange(r)) found.set(r.id, r);
  if (!usable.length && sizes.some((n) => n > 0)) for (const r of await scan(db, from, to, max * 5, (x) => score(x) > 0)) found.set(r.id, r);
  const ranked = [...found.values()].map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || b.r.at - a.r.at);
  return rows(ranked.slice(0, max).map((x) => x.r));
}

// Reads [from, to) a month at a time from the newest end, keeping what `keep` says, until `max`.
async function scan(db: IDBDatabase, from: number, to: number, max: number, keep: (r: Row) => boolean): Promise<Row[]> {
  const edges = await span();
  if (!edges) return [];
  const lo = Math.max(from, edges.first);
  let hi = Math.min(to, edges.last + 1);
  const out: Row[] = [];
  while (hi > lo && out.length < max) {
    const start = Math.max(lo, hi - WINDOW);
    const chunk = (await req(db.transaction('events').objectStore('events').index('at').getAll(IDBKeyRange.bound(start, hi, false, true)))) as Row[];
    for (let i = chunk.length - 1; i >= 0 && out.length < max; i--) if (keep(chunk[i])) out.push(chunk[i]);
    hi = start;
  }
  return out;
}

// ---------- download

export interface LifeExport {
  app: 'arise-life';
  version: 1;
  exported: string;
  events: LifeEvent[];
  summaries: LifeSummary[];
  facts: LifeFact[];
}

// Everything in the life log and the memory, oldest first, for a download (What Arise knows).
export async function exportAll(): Promise<LifeExport> {
  const db = await open();
  const tx = db.transaction(['events', 'summaries', 'facts']);
  const [ev, summaries, facts] = await Promise.all([req(tx.objectStore('events').index('at').getAll()), req(tx.objectStore('summaries').getAll()), req(tx.objectStore('facts').getAll())]);
  return {
    app: 'arise-life',
    version: 1,
    exported: new Date().toISOString(),
    events: rows(ev),
    summaries: summaries.map(cleanLifeSummary).filter((s): s is LifeSummary => !!s),
    facts: facts.map(cleanLifeFact).filter((f): f is LifeFact => !!f),
  };
}
