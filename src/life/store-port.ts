// Where life events go: the life log on this device (src/life/log.ts). Importers, linked devices
// and helpers only know this port, so they work with any store that can add events (tests use one
// in memory). A store set with setLifeStore wins; otherwise the life log is loaded when first
// needed.

import type { LifeEvent } from './types';

export interface LifeStore {
  // Adds what it doesn't have yet (same id: kept once) and says how many were new.
  addEvents(events: LifeEvent[]): Promise<number>;
}

let current: LifeStore | null = null;
const waiting: Array<(s: LifeStore) => void> = [];

export function setLifeStore(store: LifeStore | null): void {
  current = store;
  if (store) waiting.splice(0).forEach((resolve) => resolve(store));
}

// The life log module, if this build has one.
const logs = import.meta.glob<{ addEvents?: LifeStore['addEvents'] }>('./log.ts');

// The store: the one set, else the life log, loaded when first needed. null when there's none.
export async function loadLifeStore(): Promise<LifeStore | null> {
  if (current) return current;
  const load = logs['./log.ts'];
  if (!load) return null;
  try {
    const m = await load();
    if (!current && typeof m.addEvents === 'function') current = { addEvents: (events) => m.addEvents!(events) };
  } catch {}
  return current;
}

// The store, waiting for one if this build has none yet.
export function lifeStore(): Promise<LifeStore> {
  return loadLifeStore().then((s) => s || new Promise<LifeStore>((resolve) => waiting.push(resolve)));
}
