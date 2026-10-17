// Where imported events go: the life log on this device (src/life/log.ts). The import screen only
// knows this port, so it works with any store that can add events (tests use one in memory).
// app.js sets it; until the life log is part of the app, it finds it by itself when it's there.

import type { LifeEvent } from './types';

export interface LifeStore {
  // Adds what it doesn't have yet (same id: kept once) and says how many were new.
  addEvents(events: LifeEvent[]): Promise<number>;
  // Adds events, or replaces the ones with the same id that changed, and says how many were added
  // or changed. For totals (a day of steps or of a chat) that a newer export completes.
  upsertEvents?(events: LifeEvent[]): Promise<number>;
}

let current: LifeStore | null = null;

export function setLifeStore(store: LifeStore | null): void {
  current = store;
}

export function lifeStore(): LifeStore | null {
  return current;
}

// The life log module, if this build has one: an empty list until src/life/log.ts exists.
const logs = import.meta.glob<{ addEvents?: LifeStore['addEvents']; upsertEvents?: LifeStore['upsertEvents'] }>('./log.ts');

// The store: the one set, else the life log, loaded when first needed. null when there's none.
export async function loadLifeStore(): Promise<LifeStore | null> {
  if (current) return current;
  const load = logs['./log.ts'];
  if (!load) return null;
  try {
    const m = await load();
    if (typeof m.addEvents === 'function') {
      const store: LifeStore = { addEvents: (events) => m.addEvents!(events) };
      if (typeof m.upsertEvents === 'function') store.upsertEvents = (events) => m.upsertEvents!(events);
      current = store;
    }
  } catch {}
  return current;
}
