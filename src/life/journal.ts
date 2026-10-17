// Notes for the sync, made in the same database transaction as the change they're about (log.ts,
// memory.ts), so a change and its note can't come apart if the app closes:
//   - which packs changed since they were last sent (`dirty:<pack>`, with a token that's new each
//     time, so a change made while a pack is on its way keeps it marked);
//   - what was deleted one by one (the 'tomb' store), and what in one go (the wipes).
// On its own (no app imports), so the log can use it without the cloud.

import { cleanLifeWipe, type LifeWipe } from '../lib/validate';

const token = () => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

export function markDirty(tx: IDBTransaction, packs: Iterable<string>) {
  const store = tx.objectStore('sync');
  const v = token();
  for (const p of new Set(packs)) store.put({ k: `dirty:${p}`, v });
}

export function addTomb(tx: IDBTransaction, pack: string, id: string, m: number) {
  tx.objectStore('tomb').put({ k: `${pack}|${id}`, pack, id, m });
}

export const cleanWipes = (v: unknown): LifeWipe[] => (Array.isArray(v) ? v.map(cleanLifeWipe).filter((w): w is LifeWipe => !!w) : []);

export function addWipe(tx: IDBTransaction, w: LifeWipe) {
  const store = tx.objectStore('sync');
  const g = store.get('wipes');
  g.onsuccess = () => store.put({ k: 'wipes', v: [...cleanWipes((g.result as { v?: unknown } | undefined)?.v), w] });
}

// Everything the sync knew (another person's data replaced this, or this device's data was erased).
export function clearNotes(tx: IDBTransaction) {
  tx.objectStore('sync').clear();
  tx.objectStore('tomb').clear();
}

// Told after a change that marked a pack (once its transaction is done), so it goes up soon.
const watchers = new Set<() => void>();
export function onDirty(cb: () => void): () => void {
  watchers.add(cb);
  return () => watchers.delete(cb);
}
export function dirtied() {
  for (const cb of [...watchers]) {
    try {
      cb();
    } catch {}
  }
}
