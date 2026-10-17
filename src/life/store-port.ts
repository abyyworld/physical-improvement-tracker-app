// Where life events go. The life log (src/life/log.ts) registers itself here when the app starts,
// so importers, linked devices and helpers can hand over events without importing the log
// directly (and tests can use an in-memory fake).

import type { LifeEvent } from './types';

export interface LifeStore {
  // Adds the events it hasn't seen yet (by id) and returns how many were new.
  addEvents(events: LifeEvent[]): Promise<number>;
}

let store: LifeStore | null = null;
const waiting: Array<(s: LifeStore) => void> = [];

export function setLifeStore(s: LifeStore | null) {
  store = s;
  if (s) waiting.splice(0).forEach((resolve) => resolve(s));
}

// The life log, once it's ready.
export function lifeStore(): Promise<LifeStore> {
  return store ? Promise.resolve(store) : new Promise((resolve) => waiting.push(resolve));
}

// The life log's code, if this build has it.
const logs = import.meta.glob('./log.ts');

// Whether there's a life log to hand events to: one is set, or this build has one (which sets
// itself when the app starts). Without one, lifeStore() waits for good, so nothing should start
// reading for it.
export function hasLifeStore(): boolean {
  return !!store || Object.keys(logs).length > 0;
}
