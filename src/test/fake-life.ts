// An in-memory life log for tests, registered where the real one registers (life/store-port.ts).
// `full`: it also takes changed events and removes them, like the life log on its branch does.

import { setLifeStore, type LifeStore } from '../life/store-port';
import type { LifeEvent } from '../life/types';

export function fakeLife({ full = true } = {}) {
  const events = new Map<string, LifeEvent>();
  const store: LifeStore & { upsertEvents?: (e: LifeEvent[]) => Promise<number>; removeIds?: (ids: readonly string[]) => Promise<number> } = {
    async addEvents(list) {
      let n = 0;
      for (const e of list) {
        if (events.has(e.id)) continue;
        events.set(e.id, e);
        n++;
      }
      return n;
    },
  };
  if (full) {
    store.upsertEvents = async (list) => {
      for (const e of list) events.set(e.id, e);
      return list.length;
    };
    store.removeIds = async (ids) => ids.filter((id) => events.delete(id)).length;
  }
  setLifeStore(store);
  return {
    events,
    store,
    list: () => [...events.values()].sort((a, b) => a.at - b.at),
    titles: () => [...events.values()].sort((a, b) => a.at - b.at).map((e) => e.title),
  };
}
