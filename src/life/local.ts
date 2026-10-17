// The sync's side of this device's database (cloud.ts uses it): what the cloud had when this
// device last synced, which packs changed here since, a pack as this device has it, and another
// device's copy of a pack taken in. Each pack is read and written in one transaction, so a change
// made here meanwhile is never lost.

import { cleanLifeFact, cleanLifeSummary, cleanLifeSyncState, type LifeFact, type LifeSummary, type LifeSyncState, type LifeWipe } from '../lib/validate';
import { done, open, req, tellOtherTabs } from './db';
import { beforeClear, changedAt, emit, fromRow, toRow } from './log';
import { cleanWipes, clearNotes, markDirty } from './journal';
import { askedCoach, canonical, emptyContent, eventPack, isPackKey, MEM, mergeContent, monthSpan, packKind, summaryPack, syncable, syncedPrefs, tidy, wipesEvent, type Content, type SyncedEvent } from './packs';
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

// When this device's life log began to count for the account `uid` (signing in to it, cloud.ts
// joining). What's done here from then on is for that account; what was done before isn't.
export async function noteSince(uid: string, at: number): Promise<void> {
  const db = await open();
  const tx = db.transaction('sync', 'readwrite');
  tx.objectStore('sync').put({ k: 'since', v: { uid, at } });
  await done(tx);
}
export async function sinceFor(uid: string): Promise<number> {
  const db = await open();
  const row = (await req(db.transaction('sync').objectStore('sync').get('since'))) as { v?: { uid?: unknown; at?: unknown } } | undefined;
  const at = row?.v?.at;
  return row?.v?.uid === uid && typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0;
}

// Before this device's life log first syncs with an account: what was deleted here before `since`
// (cloud.ts) doesn't delete anything of the account's, and what the account deleted before then
// doesn't delete anything of this device's, as what's here counts as changed then. (Done again,
// it changes nothing more.) A question to the coach keeps its time (packs.ts).
export async function adopt(since: number): Promise<void> {
  if (!since) return;
  const db = await open();
  const tx = db.transaction(['events', 'summaries', 'facts', 'sync', 'tomb'], 'readwrite');
  const sync = tx.objectStore('sync');
  const w = sync.get('wipes');
  w.onsuccess = () => {
    const kept = cleanWipes((w.result as { v?: unknown } | undefined)?.v).filter((x) => x.at >= since);
    sync.put({ k: 'wipes', v: kept });
  };
  const walk = (store: string, each: (cur: IDBCursorWithValue) => void) => {
    const c = tx.objectStore(store).openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return;
      each(cur);
      cur.continue();
    };
  };
  let memory = 0;
  walk('tomb', (cur) => {
    const m = (cur.value as { m?: unknown }).m;
    if (!(typeof m === 'number' && m >= since)) cur.delete();
  });
  walk('events', (cur) => {
    const row = cur.value as SyncedEvent;
    if (syncable(row) && !askedCoach(row) && changedAt(row) < since) cur.update({ ...row, m: since });
  });
  for (const store of ['summaries', 'facts']) {
    walk(store, (cur) => {
      const x = cur.value as { at?: unknown };
      if (typeof x.at === 'number' && x.at < since) {
        cur.update({ ...x, at: since });
        memory++;
      }
    });
  }
  await done(tx);
  if (memory) {
    emit({ type: 'sync', count: memory, days: [], sources: [], memory: true });
    tellOtherTabs('memory');
  }
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
  newWipes: LifeWipe[]; // mem: wipes this device didn't have yet (applied here with the pack)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Brings this device's copy of a pack together with the cloud's (packs.ts): what's newer goes in
// here, and the pack is marked to go up again if this device had something the cloud didn't.
// `staleBefore`: see packs.ts.
export async function applyPack(key: string, remote: Content, { now = Date.now(), staleBefore = 0 } = {}): Promise<Applied> {
  const db = await open();
  const kind = packKind(key);
  // (kv: the questions to the coach the Player deleted, ingest.ts; events and summaries: what the
  // memory's wipes cover.)
  const tx = db.transaction([...STORES[kind], ...(kind === 'e' ? ['kv'] : kind === 'mem' ? ['events', 'summaries'] : [])], 'readwrite');
  const result: Applied = { merged: emptyContent(), changed: 0, ahead: false, newWipes: [] };
  const days = new Set<string>();
  const sources = new Set<LifeSource>();
  const wiped = { n: 0, sums: 0, days, sources };
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
      const asked: string[] = [];
      for (const e of here.events) {
        if (keep.has(e.id)) continue;
        store.delete(e.id);
        days.add(dayKey(e.at));
        sources.add(e.source);
        result.changed++;
        if (askedCoach(e) && e.id in merged.tombs) asked.push(e.id);
      }
      // A question to the coach deleted on another device isn't brought back here from the chat
      // either, as on that device (ingest.ts, deleteCoachQuestion).
      if (asked.length) {
        const kv = tx.objectStore('kv');
        const g = kv.get('dropped');
        g.onsuccess = () => {
          const was = (g.result as { v?: unknown } | undefined)?.v;
          kv.put({ k: 'dropped', v: [...new Set([...(Array.isArray(was) ? was : []), ...asked])].slice(-5000) });
        };
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
        // The memory stops learning before they land, so nothing it was about to write (made from
        // what they delete) is written after them (memory.ts).
        if (result.newWipes.length) {
          beforeClear();
          wipeIn(tx, result.newWipes, wiped);
        }
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
  result.changed += wiped.n + wiped.sums;
  if (result.changed) emit({ type: 'sync', count: result.changed, days: [...days].sort(), sources: [...sources], memory: kind !== 'e' });
  if (result.changed && kind !== 'e') tellOtherTabs('memory');
  return result;
}

// Wipes from another device: what they cover goes from this device too, in every month (even
// those whose packs didn't change), and those packs go up again without it. In `tx`, the one that
// takes in the memory's pack with them, so they're never noted as known without being applied.
function wipeIn(tx: IDBTransaction, wipes: readonly LifeWipe[], out: { n: number; sums: number; days: Set<string>; sources: Set<LifeSource> }) {
  const packs = new Set<string>();
  const memory = wipes.filter((w) => w.what !== 'events');
  let walking = memory.length ? 2 : 1;
  const ended = () => {
    if (!--walking && packs.size) markDirty(tx, packs);
  };
  const events = tx.objectStore('events').index('at').openCursor();
  events.onsuccess = () => {
    const cur = events.result;
    if (!cur) return ended();
    const row = cur.value as SyncedEvent;
    const e = fromRow(row);
    if (e && syncable(e)) {
      const se = { ...e, m: changedAt(row) };
      if (wipes.some((w) => wipesEvent(w, se))) {
        cur.delete();
        out.n++;
        out.days.add(dayKey(e.at));
        out.sources.add(e.source);
        packs.add(eventPack(e));
      }
    }
    cur.continue();
  };
  if (!memory.length) return;
  const s = tx.objectStore('summaries').openCursor();
  s.onsuccess = () => {
    const cur = s.result;
    if (!cur) return ended();
    const x = cleanLifeSummary(cur.value);
    if (x && memory.some((w) => w.at >= x.at)) {
      cur.delete();
      out.sums++;
      packs.add(summaryPack(x.id));
    }
    cur.continue();
  };
}
