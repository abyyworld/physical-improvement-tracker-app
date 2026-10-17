// The sync's side of this device's database (cloud.ts uses it): what the cloud had when this
// device last synced, which packs changed here since, a pack as this device has it, and another
// device's copy of a pack taken in. Each pack is read and written in one transaction, so a change
// made here meanwhile is never lost.

import { cleanLifeFact, cleanLifeSummary, cleanLifeSyncState, type LifeFact, type LifeSummary, type LifeSyncState, type LifeWipe } from '../lib/validate';
import { done, open, req } from './db';
import { changedAt, emit, fromRow, toRow } from './log';
import { cleanWipes, clearNotes, markDirty } from './journal';
import { canonical, emptyContent, eventPack, isPackKey, MEM, mergeContent, monthSpan, packKind, summaryPack, syncable, syncedPrefs, tidy, wipesEvent, type Content, type SyncedEvent } from './packs';
import { prefs, takePaused } from './prefs';
import { dayKey } from './dates';
import type { LifeSource } from './types';

export type SyncState = LifeSyncState;

// ---------- what the sync knows

export async function readState(): Promise<SyncState | null> {
  const db = await open();
  const row = (await req(db.transaction('sync').objectStore('sync').get('state'))) as { v?: unknown } | undefined;
  return cleanLifeSyncState(row?.v);
}

export async function writeState(st: SyncState): Promise<void> {
  const db = await open();
  const tx = db.transaction('sync', 'readwrite');
  tx.objectStore('sync').put({ k: 'state', v: st });
  await done(tx);
}

// The packs changed here since they were last sent, each with its mark.
export async function dirtyMarks(): Promise<Map<string, string>> {
  const db = await open();
  const rows = (await req(db.transaction('sync').objectStore('sync').getAll(IDBKeyRange.bound('dirty:', 'dirty:￿')))) as { k: string; v: string }[];
  return new Map(rows.map((r) => [r.k.slice(6), r.v] as [string, string]).filter(([k]) => isPackKey(k)));
}

export async function markPacks(packs: Iterable<string>): Promise<void> {
  const db = await open();
  const tx = db.transaction('sync', 'readwrite');
  markDirty(tx, packs);
  await done(tx);
}

// These packs went up (or had nothing to send): their marks go, unless they changed again since.
export async function settle(marks: Map<string, string>, packs: Iterable<string>): Promise<void> {
  const list = [...new Set(packs)].filter((k) => marks.has(k));
  if (!list.length) return;
  const db = await open();
  const tx = db.transaction('sync', 'readwrite');
  const store = tx.objectStore('sync');
  for (const k of list) {
    const g = store.get(`dirty:${k}`);
    g.onsuccess = () => {
      if ((g.result as { v?: string } | undefined)?.v === marks.get(k)) store.delete(`dirty:${k}`);
    };
  }
  await done(tx);
}

// Everything the sync knew goes (the account was deleted): the log itself stays.
export async function forget(): Promise<void> {
  const db = await open();
  const tx = db.transaction(['sync', 'tomb'], 'readwrite');
  clearNotes(tx);
  await done(tx);
}

// Every pack this device has anything for (a month with events, a year with summaries, the
// memory, and any with deletions to send).
export async function localPacks(): Promise<string[]> {
  const db = await open();
  const out = new Set<string>([MEM]);
  const tx = db.transaction(['events', 'summaries', 'tomb']);
  // (All asked at once: a transaction ends once nothing is waiting on it.)
  const walk = (c: IDBRequest<IDBCursor | null>, next: (cur: IDBCursor) => void) =>
    new Promise<void>((resolve, reject) => {
      c.onerror = () => reject(c.error);
      c.onsuccess = () => (c.result ? next(c.result) : resolve());
    });
  const months = walk(tx.objectStore('events').index('at').openKeyCursor(), (cur) => {
    const k = eventPack({ at: cur.key as number });
    out.add(k);
    cur.continue(monthSpan(k)[1]); // straight on to the next month
  });
  const tombs = walk(tx.objectStore('tomb').index('pack').openKeyCursor(null, 'nextunique'), (cur) => {
    out.add(String(cur.key));
    cur.continue();
  });
  const [sums] = await Promise.all([req(tx.objectStore('summaries').getAllKeys()), months, tombs]);
  for (const id of sums) out.add(summaryPack(String(id)));
  return [...out].filter(isPackKey);
}

// ---------- a pack as this device has it

interface Local {
  content: Content; // as stored, not tidied
  wipes: LifeWipe[];
}

const STORES = { e: ['events', 'tomb', 'sync'], s: ['summaries', 'tomb', 'sync'], mem: ['facts', 'tomb', 'sync'] } as const;

// Reads this device's copy of a pack in `tx`, then calls `then` while the transaction is still
// open (so it can write in the same go).
function readLocal(tx: IDBTransaction, key: string, then: (l: Local) => void) {
  const kind = packKind(key);
  const reqs: IDBRequest[] = [];
  const items = kind === 'e' ? tx.objectStore('events').index('at').getAll(IDBKeyRange.bound(...monthSpan(key), false, true)) : tx.objectStore(kind === 's' ? 'summaries' : 'facts').getAll();
  const tombs = tx.objectStore('tomb').index('pack').getAll(key);
  const wipes = tx.objectStore('sync').get('wipes');
  reqs.push(items, tombs, wipes);
  let left = reqs.length;
  const fail = (err: unknown) => {
    failures.set(tx, err);
    try {
      tx.abort();
    } catch {}
  };
  for (const r of reqs) {
    r.onsuccess = () => {
      if (--left) return;
      try {
        const c = emptyContent();
        if (kind === 'e') {
          for (const row of items.result as unknown[]) {
            const e = fromRow(row);
            if (e && syncable(e)) c.events.push({ ...e, m: changedAt(row) });
          }
        } else if (kind === 's') c.sums = (items.result as unknown[]).map(cleanLifeSummary).filter((s): s is LifeSummary => !!s && summaryPack(s.id) === key);
        else {
          c.facts = (items.result as unknown[]).map(cleanLifeFact).filter((f): f is LifeFact => !!f);
          c.prefs = syncedPrefs(prefs());
        }
        for (const t of tombs.result as { id?: unknown; m?: unknown }[]) if (typeof t.id === 'string' && typeof t.m === 'number') c.tombs[t.id] = t.m;
        const w = cleanWipes((wipes.result as { v?: unknown } | undefined)?.v);
        if (kind === 'mem') c.wipes = w;
        then({ content: c, wipes: w });
      } catch (err) {
        fail(err);
      }
    };
  }
}

// An error thrown inside a transaction's callbacks, to report instead of the abort it caused.
const failures = new WeakMap<IDBTransaction, unknown>();
async function finish(tx: IDBTransaction) {
  try {
    await done(tx);
  } catch (err) {
    throw failures.get(tx) ?? err;
  }
}

// This device's copy of a pack, tidied (old tombstones gone, wipes applied): what it sends.
export async function buildPack(key: string, now = Date.now()): Promise<Content> {
  const db = await open();
  const tx = db.transaction([...STORES[packKind(key)]]);
  let out: Content = emptyContent();
  readLocal(tx, key, (l) => {
    out = tidy(key, l.content, { now, wipes: l.wipes });
  });
  await finish(tx);
  return out;
}

// ---------- another device's copy taken in

export interface Applied {
  merged: Content;
  changed: number; // items changed here
  ahead: boolean; // this device had something the cloud didn't: the pack goes up again
  newWipes: LifeWipe[]; // mem: wipes this device didn't have yet
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Brings this device's copy of a pack together with the cloud's (packs.ts): what's newer goes in
// here, and the pack is marked to go up again if this device had something the cloud didn't.
// `staleBefore`: see packs.ts.
export async function applyPack(key: string, remote: Content, { now = Date.now(), staleBefore = 0 } = {}): Promise<Applied> {
  const db = await open();
  const kind = packKind(key);
  const tx = db.transaction([...STORES[kind]], 'readwrite');
  const result: Applied = { merged: emptyContent(), changed: 0, ahead: false, newWipes: [] };
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  let prefsTo: Content['prefs'] | null = null;
  readLocal(tx, key, ({ content: here, wipes }) => {
    const merged = mergeContent(key, here, remote, { now, staleBefore, wipes });
    result.merged = merged;
    if (kind === 'e') {
      const store = tx.objectStore('events');
      const mine = new Map(here.events.map((e) => [e.id, e]));
      const keep = new Set<string>();
      const put = (e: SyncedEvent) => {
        const { m, ...ev } = e;
        store.put(toRow(ev, m));
        days.add(dayKey(e.at));
        sources.add(e.source);
        result.changed++;
      };
      for (const e of merged.events) {
        keep.add(e.id);
        if (same(mine.get(e.id), e)) continue;
        if (mine.has(e.id)) {
          put(e);
          continue;
        }
        // Not in this month here, but maybe in another one, changed since (moved): that stays.
        const g = store.get(e.id);
        g.onsuccess = () => {
          if (!g.result || changedAt(g.result) <= e.m) put(e);
        };
      }
      for (const e of here.events) {
        if (keep.has(e.id)) continue;
        store.delete(e.id);
        days.add(dayKey(e.at));
        sources.add(e.source);
        result.changed++;
      }
    } else {
      const store = tx.objectStore(kind === 's' ? 'summaries' : 'facts');
      const list: { id: string }[] = kind === 's' ? merged.sums : merged.facts;
      const mine = new Map<string, unknown>((kind === 's' ? here.sums : here.facts).map((x) => [x.id, x]));
      const keep = new Set<string>();
      for (const x of list) {
        keep.add(x.id);
        if (same(mine.get(x.id), x)) continue;
        store.put(x);
        result.changed++;
      }
      for (const id of mine.keys()) {
        if (keep.has(id)) continue;
        store.delete(id);
        result.changed++;
      }
      if (kind === 'mem') {
        const known = new Set(wipes.map((w) => JSON.stringify(w)));
        result.newWipes = merged.wipes.filter((w) => !known.has(JSON.stringify(w)));
        if (!same(merged.wipes, wipes)) tx.objectStore('sync').put({ k: 'wipes', v: merged.wipes });
        if (!same(merged.prefs, here.prefs)) {
          prefsTo = merged.prefs;
          result.changed++;
        }
      }
    }
    // The deletions to keep (the rest are taken in, or too old to matter).
    const tombs = tx.objectStore('tomb');
    for (const [id, m] of Object.entries(merged.tombs)) if (here.tombs[id] !== m) tombs.put({ k: `${key}|${id}`, pack: key, id, m });
    for (const id of Object.keys(here.tombs)) if (!(id in merged.tombs)) tombs.delete(`${key}|${id}`);
    // This device had more than the cloud: it goes up again.
    result.ahead = canonical(key, merged) !== canonical(key, remote);
    if (result.ahead) markDirty(tx, [key]);
  });
  await finish(tx);
  if (prefsTo) takePaused((prefsTo as Content['prefs']).paused, (prefsTo as Content['prefs']).at);
  if (result.changed) emit({ type: 'sync', count: result.changed, days: [...days].sort(), sources: [...sources], memory: kind !== 'e' });
  return result;
}

// Wipes from another device: what they cover goes from this device too, in every month (even
// those whose packs didn't change), and those packs go up again without it.
export async function applyWipes(wipes: readonly LifeWipe[]): Promise<number> {
  if (!wipes.length) return 0;
  const db = await open();
  const tx = db.transaction(['events', 'summaries', 'sync'], 'readwrite');
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const packs = new Set<string>();
  let n = 0;
  const events = tx.objectStore('events').index('at').openCursor();
  events.onsuccess = () => {
    const cur = events.result;
    if (!cur) return;
    const row = cur.value as SyncedEvent;
    const e = fromRow(row);
    if (e && syncable(e)) {
      const se = { ...e, m: changedAt(row) };
      if (wipes.some((w) => wipesEvent(w, se))) {
        cur.delete();
        n++;
        days.add(dayKey(e.at));
        sources.add(e.source);
        packs.add(eventPack(e));
      }
    }
    cur.continue();
  };
  const memory = wipes.filter((w) => w.what !== 'events');
  let sums = 0;
  if (memory.length) {
    const s = tx.objectStore('summaries').openCursor();
    s.onsuccess = () => {
      const cur = s.result;
      if (!cur) return;
      const x = cleanLifeSummary(cur.value);
      if (x && memory.some((w) => w.at >= x.at)) {
        cur.delete();
        sums++;
        packs.add(summaryPack(x.id));
      }
      cur.continue();
    };
  }
  await done(tx);
  if (packs.size) await markPacks(packs);
  if (n || sums) emit({ type: 'sync', count: n + sums, days: [...days].sort(), sources: [...sources], memory: sums > 0 });
  return n + sums;
}
